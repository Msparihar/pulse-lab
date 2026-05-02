"""
main.py — Pulse Lab FastAPI backend
Serves the static React-via-CDN frontend and provides the SSE analyze endpoint.

Set STUB_MODE=1 to skip model loading and emit deterministic fake data instead
(useful for UI development without the heavy JAX / open-rppg install).
"""
import json
import os
import shutil
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    if STUB_MODE:
        print("STUB_MODE=1 — skipping model load, using fake_chunk_stream.")
        app.state.model = None
    else:
        import numpy as np

        print("Loading open-rppg model...")
        import rppg  # noqa: PLC0415  (lazy import — heavy JAX deps)

        model = rppg.Model("FacePhys.rlap")
        app.state.model = model

        print("Warming up JAX (one-time ~5-10s)...")
        dummy = np.random.randint(0, 256, (60, 240, 320, 3), dtype=np.uint8)
        try:
            model.process_video_tensor(dummy, fps=30.0)
        except Exception as exc:
            print(f"JAX warmup raised (ignored): {exc}")

        print("Ready.")

    app.state.jobs = {}
    yield
    print("Bye.")


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
    """Accept a video upload, save it, return a job_id."""
    job_id = str(uuid.uuid4())
    suffix = Path(file.filename or "").suffix or ".mp4"
    dest = UPLOADS_DIR / f"{job_id}{suffix}"
    contents = await file.read()
    dest.write_bytes(contents)
    app.state.jobs[job_id] = dest
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
        raise HTTPException(status_code=404, detail="job_id not found")

    async def event_generator():
        try:
            if STUB_MODE:
                source = fake_chunk_stream()
            else:
                source = real_chunk_stream(video_path, app.state.model)

            async for event in source:
                event_type = event.pop("type")
                data = json.dumps(event)
                yield f"event: {event_type}\ndata: {data}\n\n"
        except Exception as exc:
            error_payload = json.dumps({"error": f"{type(exc).__name__}: {exc}"})
            yield f"event: error\ndata: {error_payload}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
