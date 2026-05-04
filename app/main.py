"""
main.py — Pulse Lab FastAPI backend
Serves the static React-via-CDN frontend and provides the SSE analyze endpoint.

Set STUB_MODE=1 to skip model loading and emit deterministic fake data instead
(useful for UI development without the heavy JAX / open-rppg install).
"""
import asyncio
import json
import logging
import os
import shutil
import sys
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from pipeline.chunker import fake_chunk_stream, real_chunk_stream

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

STUB_MODE = os.environ.get("STUB_MODE") == "1"

# ---------------------------------------------------------------------------
# Logging setup — configure once here, before anything else runs.
# We add a StreamHandler to stdout so Docker/Dokploy captures structured logs.
# We do NOT touch uvicorn's own loggers (uvicorn, uvicorn.access, uvicorn.error)
# so their output continues unmodified alongside ours.
# ---------------------------------------------------------------------------
_log_level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
_log_level = getattr(logging, _log_level_name, logging.INFO)

_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(
    logging.Formatter(
        fmt="%(asctime)s.%(msecs)03d %(levelname)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )
)

# Apply to the root logger at WARNING so we don't swamp with library noise,
# then set our own namespaces explicitly.
logging.getLogger().setLevel(logging.WARNING)
logging.getLogger().addHandler(_handler)

for _ns in ("app.main", "app.pipeline"):
    _lg = logging.getLogger(_ns)
    _lg.setLevel(_log_level)
    _lg.propagate = True  # bubbles up to root handler above

logger = logging.getLogger("app.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("[BOOT] Starting Pulse Lab v0.2.0 STUB_MODE=%s", STUB_MODE)

    if STUB_MODE:
        logger.info("[BOOT] STUB_MODE=1 — skipping model load, using fake_chunk_stream.")
        app.state.model = None
    else:
        import numpy as np

        logger.info("[BOOT] Loading FacePhys.rlap...")
        t0 = time.perf_counter()
        import rppg  # noqa: PLC0415  (lazy import — heavy JAX deps)

        model = rppg.Model("FacePhys.rlap")
        app.state.model = model
        logger.info("[BOOT] Model loaded in %dms", int((time.perf_counter() - t0) * 1000))

        logger.info("[BOOT] Starting JAX warmup...")
        t1 = time.perf_counter()
        dummy = np.random.randint(0, 256, (60, 240, 320, 3), dtype=np.uint8)
        try:
            model.process_video_tensor(dummy, fps=30.0)
        except Exception as exc:
            logger.warning("[BOOT] JAX warmup raised (ignored): %s", exc)
        logger.info("[BOOT] Warmup complete in %dms", int((time.perf_counter() - t1) * 1000))

    app.state.jobs = {}
    yield
    logger.info("[BOOT] Shutdown — bye.")


app = FastAPI(title="Pulse Lab", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static assets (JSX/CSS/etc.)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/analyze")
async def analyze(file: UploadFile):
    """Accept a video upload, save it, validate duration, return a job_id."""
    import cv2  # noqa: PLC0415

    job_id = str(uuid.uuid4())
    suffix = Path(file.filename or "").suffix or ".mp4"
    dest = UPLOADS_DIR / f"{job_id}{suffix}"
    contents = await file.read()
    dest.write_bytes(contents)

    # Validate minimum duration (30s floor)
    duration = 0.0
    try:
        cap = cv2.VideoCapture(str(dest))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        cap.release()
        duration = frame_count / fps if fps > 0 else 0
        if duration < 30:
            dest.unlink(missing_ok=True)
            raise HTTPException(
                status_code=400,
                detail=f"Video too short ({duration:.0f}s) — need at least 30 seconds for a reliable reading.",
            )
    except HTTPException:
        raise
    except Exception:
        # If cv2 can't probe it (unusual format), allow it through — the pipeline will fail gracefully.
        pass

    app.state.jobs[job_id] = dest
    logger.info(
        "[JOB] Created job_id=%s from upload size=%d duration=%.1fs",
        job_id, len(contents), duration,
    )
    return {"job_id": job_id}


@app.post("/api/analyze/sample")
async def analyze_sample():
    """Register the bundled sample video as a fresh job. Returns the same
    {job_id} shape as the upload endpoint so the frontend can stream from
    the same /api/analyze/{job_id}/stream URL."""
    sample = STATIC_DIR / "samples" / "sample-face-60s.mp4"
    if not sample.exists():
        raise HTTPException(status_code=404, detail="Sample video not bundled")
    job_id = str(uuid.uuid4())
    dest = UPLOADS_DIR / f"{job_id}.mp4"
    shutil.copyfile(sample, dest)
    app.state.jobs[job_id] = dest
    logger.info("[JOB] Created job_id=%s from sample", job_id)
    return {"job_id": job_id}


@app.get("/api/analyze/{job_id}/stream")
async def stream(job_id: str):
    """
    SSE stream for a given job.
    Emits 12 'chunk' events followed by a 'final' event.
    Named SSE events let the frontend use addEventListener('chunk', ...) and
    addEventListener('final', ...) instead of the generic onmessage handler.
    On any mid-stream exception, emits a single 'error' event so the frontend
    can show the failure card instead of hanging indefinitely.
    """
    video_path: Path | None = app.state.jobs.get(job_id)
    if video_path is None or not video_path.exists():
        logger.warning("[JOB] Stream NOT FOUND job_id=%s", job_id)
        raise HTTPException(status_code=404, detail="job_id not found")

    logger.info("[JOB] Stream requested job_id=%s", job_id)
    stream_t0 = time.time()

    async def event_generator():
        logger.info("[SSE] Generator open job_id=%s", job_id)
        reason = "done"
        try:
            if STUB_MODE:
                source = fake_chunk_stream(job_id=job_id)
            else:
                source = real_chunk_stream(video_path, app.state.model, job_id=job_id)

            async for event in source:
                event_type = event.pop("type")
                data = json.dumps(event)
                payload = f"event: {event_type}\ndata: {data}\n\n"
                # Log before yielding so we can tell if the yield itself blocks.
                logger.info(
                    "[SSE] Yielded event_type=%s idx=%s bytes=%d job_id=%s",
                    event_type,
                    event.get("idx", "-"),
                    len(payload),
                    job_id,
                )
                yield payload
                # Give uvicorn/h11 a chance to flush the chunk to the TCP socket
                # before we block on the next inference call. Without this, the
                # coroutine may not yield control back to the event loop and the
                # bytes sit in the kernel send buffer until the next yield.
                await asyncio.sleep(0)
        except Exception as exc:
            reason = "exception"
            logger.error(
                "[ERROR] %s: %s job_id=%s",
                type(exc).__name__, exc, job_id,
            )
            logger.debug("[ERROR] Traceback:\n%s", traceback.format_exc())
            error_payload = json.dumps({"error": f"{type(exc).__name__}: {exc}"})
            yield f"event: error\ndata: {error_payload}\n\n"
        finally:
            total_s = time.time() - stream_t0
            logger.info(
                "[SSE] Generator closing job_id=%s reason=%s",
                job_id, reason,
            )
            logger.info(
                "[JOB] Stream finished job_id=%s total_seconds=%.1f",
                job_id, total_s,
            )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            # no-transform: ask proxies not to modify (compress/buffer) the body.
            # Buffering proxies (nginx gzip, Traefik middleware) can hold SSE
            # chunks until their internal buffer fills, causing the "stuck at
            # chunk 1" symptom. no-transform is the HTTP-level signal to skip that.
            "Cache-Control": "no-cache, no-transform",
            # keep-alive: tell downstream load-balancers not to close the
            # connection on idle gaps between chunk events.
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    """Return index.html for all non-API, non-static paths (SPA deep-link support)."""
    if full_path.startswith("api/") or full_path.startswith("static/"):
        raise HTTPException(status_code=404)
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
