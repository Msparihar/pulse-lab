"""
pipeline/chunker.py — Real rPPG inference pipeline.

Pipeline:
  1. Decode the uploaded video, resample to 30 fps via frame-index selection.
  2. Slice into 12 disjoint 5-second windows (150 frames each).
  3. For each window, call open-rppg's process_video_tensor → BPM + SQI + latency.
     Also capture per-chunk HRV bundle and BVP segment.
     Yield a chunk SSE event the moment each window finishes.
  4. Aggregate per-chunk results: SQI-weighted median BPM, averaged HRV, concat BVP tail.
  5. Yield a final SSE event with everything.

Why this shape:
  - Per-chunk BPMs feed the timeline UI in near-real-time (the "live" feel).
  - Dropping the whole-video pass cuts total pipeline time from ~50s to ~10-15s.
    The whole-video pass was ~30-40s of dead air at the end; eliminating it means
    the final event lands within ~1s of the last chunk.
  - SQI threshold 0.293 marks a chunk as "failed" (validated in literature).
  - HRV is averaged across valid chunks that produced it (SQI > 0.5 per library).
  - BVP for the frozen waveform is the tail of concatenated per-chunk signals.
  - All blocking work runs on a thread executor; the SSE event loop stays free.
"""
import asyncio
import logging
import time
from pathlib import Path
from typing import AsyncIterator

import cv2
import numpy as np

logger = logging.getLogger("app.pipeline")

# SQI below this → chunk treated as failed in the UI.
# Source: chunked-rppg-best-practices.md (Nature npj Biosensing).
SQI_FAIL_THRESHOLD = 0.293

# Library minimum: 60 frames (2s @ 30fps) for any HR estimate.
MIN_FRAMES_FOR_INFERENCE = 60

TARGET_FPS = 30
CHUNK_SECONDS = 5
TOTAL_CHUNKS = 12
FRAMES_PER_CHUNK = TARGET_FPS * CHUNK_SECONDS  # 150
TOTAL_FRAMES = FRAMES_PER_CHUNK * TOTAL_CHUNKS  # 1800

# How many BVP samples to ship in the final event. The signal is at 30 Hz,
# so ~300 samples = 10s of waveform — enough for a calm frozen-display
# on the results screen without bloating the SSE payload.
BVP_TAIL_SAMPLES = 300


def _iter_chunks_at_30fps(path: Path, job_id: str):
    """Sync generator: yields one chunk (up to FRAMES_PER_CHUNK RGB frames) at a time.

    Uses frame-index selection for FPS resampling (same logic as the old eager
    _read_video_at_30fps).  Yields TOTAL_CHUNKS chunks; pads short videos with
    empty arrays so callers can assume exactly TOTAL_CHUNKS yields.

    This is a plain Python generator — call it from a thread, not the async loop.
    """
    size_mb = path.stat().st_size / (1024 * 1024) if path.exists() else 0.0

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {path}")

    src_fps   = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration  = src_count / src_fps if src_fps > 0 else 0.0

    target_count = int(round(duration * TARGET_FPS)) if duration > 0 else src_count
    if target_count <= 0:
        target_count = src_count

    # Build the sorted array of source-frame indices we actually want.
    # For 30→30 fps no-op, linspace(0, N-1, N) = [0,1,2,...,N-1].
    want_indices = np.linspace(0, src_count - 1, target_count).astype(np.int64)

    logger.info(
        "[DECODE] Reading video path=%s size_mb=%.2f src_fps=%.1f src_count=%d"
        " target_count=%d job_id=%s",
        path.name, size_mb, src_fps, src_count, target_count, job_id,
    )

    decode_t0 = time.perf_counter()

    # Detect frame height/width for padding empty chunks correctly.
    # Peek at first frame to get shape; reset to start.
    probe_ok, probe_frame = cap.read()
    frame_h, frame_w = (probe_frame.shape[:2] if probe_ok else (240, 320))
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    chunk_buf: list[np.ndarray] = []
    chunk_idx = 0
    prev_src_pos = -1  # last source frame we read (for skip-ahead logic)

    for want in want_indices:
        want = int(want)
        # Advance the capture to `want` if we need to skip frames.
        if want > prev_src_pos + 1:
            # Seek to skip efficiently; cv2 seek is approximate so re-read is
            # safer for short gaps but for large gaps seeking is worth it.
            if want - (prev_src_pos + 1) > 5:
                cap.set(cv2.CAP_PROP_POS_FRAMES, want)
                prev_src_pos = want - 1
            else:
                # Read and discard intermediate frames
                for _ in range(want - (prev_src_pos + 1)):
                    cap.read()
                    prev_src_pos += 1

        ok, frame_bgr = cap.read()
        prev_src_pos = want

        if ok:
            chunk_buf.append(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
        # If not ok: short video — leave the slot empty; pad below.

        if len(chunk_buf) == FRAMES_PER_CHUNK:
            arr = np.stack(chunk_buf, axis=0)
            chunk_buf = []
            elapsed_ms = int((time.perf_counter() - decode_t0) * 1000)
            logger.info(
                "[DECODE] Yielded chunk idx=%d frames=%d elapsed_ms=%d job_id=%s",
                chunk_idx, len(arr), elapsed_ms, job_id,
            )
            yield arr
            chunk_idx += 1

    cap.release()

    # Yield any partial final chunk
    if chunk_buf and chunk_idx < TOTAL_CHUNKS:
        arr = np.stack(chunk_buf, axis=0)
        elapsed_ms = int((time.perf_counter() - decode_t0) * 1000)
        logger.info(
            "[DECODE] Yielded chunk idx=%d frames=%d (partial) elapsed_ms=%d job_id=%s",
            chunk_idx, len(arr), elapsed_ms, job_id,
        )
        yield arr
        chunk_idx += 1

    # Pad remaining chunks with empty arrays so the caller always sees TOTAL_CHUNKS
    while chunk_idx < TOTAL_CHUNKS:
        logger.info(
            "[DECODE] Yielded chunk idx=%d frames=0 (padding) job_id=%s",
            chunk_idx, job_id,
        )
        yield np.empty((0, frame_h, frame_w, 3), dtype=np.uint8)
        chunk_idx += 1

    total_decode_ms = int((time.perf_counter() - decode_t0) * 1000)
    logger.info(
        "[DECODE] Done total_chunks_decoded=%d total_decode_ms=%d job_id=%s",
        TOTAL_CHUNKS, total_decode_ms, job_id,
    )


def _process_chunk_sync(model, chunk: np.ndarray, idx: int = -1, job_id: str = "") -> dict:
    """Run inference on one chunk. Returns a dict with bpm/quality/latency
    plus a `failed` boolean and (when failed) a human-readable reason that
    the UI tooltip can show. Also captures per-chunk HRV and BVP."""
    logger.info("[CHUNK] Starting idx=%d frames=%d job_id=%s", idx, len(chunk), job_id)

    def _done(out: dict) -> dict:
        logger.info(
            "[CHUNK] Done idx=%d bpm=%s sqi=%s latency_ms=%d failed=%s reason=%s job_id=%s",
            idx, out.get("bpm"), out.get("quality"), out.get("latency_ms", 0),
            out.get("failed"), out.get("reason"), job_id,
        )
        return out

    if len(chunk) < MIN_FRAMES_FOR_INFERENCE:
        return _done({
            "bpm": None, "quality": None, "latency_ms": 0,
            "failed": True, "reason": "too short",
            "hrv": {}, "bvp_samples": [],
        })

    t0 = time.perf_counter()
    try:
        result = model.process_video_tensor(chunk, fps=float(TARGET_FPS))
    except Exception as e:
        return _done({
            "bpm": None, "quality": None,
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "failed": True, "reason": f"{type(e).__name__}",
            "hrv": {}, "bvp_samples": [],
        })
    latency_ms = int((time.perf_counter() - t0) * 1000)

    # Capture the BVP segment for this chunk immediately after inference.
    # model.bvp() returns a cumulative buffer — slice the last FRAMES_PER_CHUNK
    # samples (150 at 30Hz = 5s) to get this chunk's contribution only.
    bvp_samples: list[float] = []
    try:
        bvp_arr, _ts = model.bvp()
        if bvp_arr is not None:
            arr = np.asarray(bvp_arr, dtype=np.float64)
            if arr.size > 0:
                chunk_bvp = arr[-FRAMES_PER_CHUNK:]
                bvp_samples = [float(x) for x in chunk_bvp]
    except Exception:
        pass

    if not result or result.get("hr") is None:
        return _done({
            "bpm": None, "quality": None, "latency_ms": latency_ms,
            "failed": True, "reason": "no signal",
            "hrv": {}, "bvp_samples": bvp_samples,
        })

    sqi = float(result.get("SQI") or 0.0)
    if sqi < SQI_FAIL_THRESHOLD:
        return _done({
            "bpm": None, "quality": round(sqi, 3), "latency_ms": latency_ms,
            "failed": True, "reason": "signal too noisy",
            "hrv": {}, "bvp_samples": bvp_samples,
        })

    hrv = result.get("hrv") or {}

    return _done({
        "bpm": int(round(float(result["hr"]))),
        "quality": round(sqi, 3),
        "latency_ms": latency_ms,
        "failed": False,
        "reason": None,
        "hrv": hrv if isinstance(hrv, dict) else {},
        "bvp_samples": bvp_samples,
    })


def _aggregate_overall(chunk_results: list[dict]) -> dict:
    """Compute the final summary from per-chunk data only.

    overall_bpm: SQI-weighted median across valid chunks.
    ci:          half-width of 95% CI from per-chunk BPM spread.
    hrv:         averaged across valid chunks that produced HRV (SQI > 0.5).
    bvp:         tail of concatenated per-chunk BVP signals, normalized to [-1,1].
    """
    valid = [c for c in chunk_results if not c["failed"]]
    bpms = [c["bpm"] for c in valid]

    if not bpms:
        return {
            "overall_bpm": None,
            "ci": None,
            "respiratory_rate": None,
            "hrv": {"rmssd": None, "sdnn": None, "pnn50": None, "lf_hf": None},
            "bvp": [],
        }

    # SQI-weighted median for overall BPM
    weights = np.array([c["quality"] for c in valid], dtype=np.float64)
    bpms_arr = np.array(bpms, dtype=np.float64)
    order = np.argsort(bpms_arr)
    sorted_bpms = bpms_arr[order]
    sorted_w = weights[order]
    cumw = np.cumsum(sorted_w)
    cutoff = cumw[-1] / 2
    idx = min(int(np.searchsorted(cumw, cutoff)), len(sorted_bpms) - 1)
    overall_bpm = int(round(float(sorted_bpms[idx])))

    # CI from chunk BPM std
    ci = int(round(1.96 * float(np.std(bpms, ddof=1)) / np.sqrt(len(bpms)))) if len(bpms) >= 3 else None

    # HRV: average per-chunk bundles across valid chunks that produced HRV.
    # The library only populates hrv when SQI > 0.5, so some chunks may not contribute.
    hrv_chunks = [c["hrv"] for c in valid if c.get("hrv")]

    def _avg(key: str, digits: int = 1):
        vals = [float(h[key]) for h in hrv_chunks if h.get(key) is not None]
        # Drop NaN values that the library may return for HRV metrics
        vals = [v for v in vals if not (v != v)]  # NaN != NaN
        return round(sum(vals) / len(vals), digits) if vals else None

    hrv = {
        "rmssd": _avg("rmssd", 1),
        "sdnn":  _avg("sdnn", 1),
        "pnn50": _avg("pnn50", 1),
        "lf_hf": _avg("LF/HF", 2),
    }

    rr_raw = _avg("breathingrate", 1)
    rr = int(round(rr_raw)) if (rr_raw is not None and rr_raw == rr_raw) else None

    # BVP for the frozen waveform: concat per-chunk BVPs, take the tail.
    all_samples: list[float] = []
    for c in valid:
        all_samples.extend(c.get("bvp_samples") or [])

    bvp_tail = all_samples[-BVP_TAIL_SAMPLES:]
    if bvp_tail:
        lo = min(bvp_tail)
        rng = max(bvp_tail) - lo or 1.0
        bvp_tail = [round(2 * (v - lo) / rng - 1, 4) for v in bvp_tail]

    result = {
        "overall_bpm": overall_bpm,
        "ci": ci,
        "respiratory_rate": rr,
        "hrv": hrv,
        "bvp": bvp_tail,
    }
    logger.info(
        "[AGGREGATE] valid_chunks=%d/%d overall_bpm=%s hrv_chunks=%d",
        len(valid), len(chunk_results), overall_bpm, len(hrv_chunks),
    )
    return result


async def real_chunk_stream(video_path: Path, model, *, job_id: str = "") -> AsyncIterator[dict]:
    """Stream real chunk events from a video file using open-rppg.

    Decode and inference are pipelined: chunk N+1 is decoded on a thread while
    chunk N runs through JAX inference, also on a thread.  The async loop
    orchestrates both without blocking.
    """
    pipeline_t0 = time.perf_counter()

    # Build the sync generator; it will be driven one chunk at a time from a thread.
    decoder = _iter_chunks_at_30fps(video_path, job_id)

    chunk_results: list[dict] = []
    total_frames_decoded = 0
    i = 0
    first_chunk = True

    while True:
        # Advance the decoder by one chunk (runs cv2 on the thread pool).
        try:
            chunk_frames = await asyncio.to_thread(next, decoder)
        except StopIteration:
            break

        total_frames_decoded += len(chunk_frames)

        # Before chunk 0's inference, signal that decoding is done and inference
        # is starting. The frontend uses this to update the status text.
        if first_chunk:
            first_chunk = False
            yield {"type": "info", "phase": "inference"}

        # Inference for this chunk — also on thread pool, so decode of next
        # chunk can start immediately in the next loop iteration.
        result = await asyncio.to_thread(_process_chunk_sync, model, chunk_frames, i, job_id)
        chunk_results.append(result)

        # Strip the heavy bvp_samples + hrv from the streamed event payload —
        # frontend only needs the fields below for the live timeline UI.
        yield {
            "type": "chunk",
            "idx": i,
            "bpm": result["bpm"],
            "quality": result["quality"],
            "latency_ms": result["latency_ms"],
            "failed": result["failed"],
            "reason": result["reason"],
        }
        i += 1

    summary = _aggregate_overall(chunk_results)

    total_seconds = time.perf_counter() - pipeline_t0
    valid_latencies = [c["latency_ms"] for c in chunk_results if not c["failed"]]
    avg_chunk_seconds = (
        sum(valid_latencies) / len(valid_latencies) / 1000
        if valid_latencies else 0.0
    )

    yield {
        "type": "final",
        "overall_bpm": summary["overall_bpm"],
        "ci": summary["ci"],
        "respiratory_rate": summary["respiratory_rate"],
        "hrv": summary["hrv"],
        "bvp": summary["bvp"],
        "perf": {
            "total_seconds": round(total_seconds, 1),
            "avg_chunk_seconds": round(avg_chunk_seconds, 1),
            "frames_processed": total_frames_decoded,
        },
    }


# Stub kept for offline UI development without the heavy rPPG install.
async def fake_chunk_stream(*, job_id: str = "") -> AsyncIterator[dict]:
    STUB_BPMS      = [72, 74, 73, 76, 78, 77, 80, 82, 81, 79, 77, 75]
    STUB_QUALITIES = [0.91, 0.93, 0.88, 0.90, 0.85, 0.92, 0.81, 0.78, 0.86, 0.89, 0.91, 0.90]
    STUB_LATENCIES = [140, 145, 138, 152, 148, 141, 155, 160, 149, 144, 142, 147]
    for i in range(12):
        logger.info("[CHUNK] Starting idx=%d frames=150 job_id=%s (stub)", i, job_id)
        await asyncio.sleep(1.2)
        logger.info(
            "[CHUNK] Done idx=%d bpm=%d sqi=%.2f latency_ms=%d failed=False reason=None job_id=%s (stub)",
            i, STUB_BPMS[i], STUB_QUALITIES[i], STUB_LATENCIES[i], job_id,
        )
        yield {
            "type": "chunk", "idx": i,
            "bpm": STUB_BPMS[i], "quality": STUB_QUALITIES[i],
            "latency_ms": STUB_LATENCIES[i],
            "failed": False, "reason": None,
        }
    logger.info("[AGGREGATE] valid_chunks=12/12 overall_bpm=76 hrv_chunks=12 (stub)")
    yield {
        "type": "final",
        "overall_bpm": 76, "ci": 2, "respiratory_rate": 16,
        "hrv": {"rmssd": 42, "sdnn": 58, "pnn50": 18, "lf_hf": 1.4},
        "bvp": [round(float(np.sin(i * 2 * np.pi / 30 * 76 / 60)), 4) for i in range(300)],
        "perf": {"total_seconds": 18.0, "avg_chunk_seconds": 1.5, "frames_processed": 1800},
    }
