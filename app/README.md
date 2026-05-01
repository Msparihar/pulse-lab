# Pulse Lab — rPPG Demo

A FastAPI-backed demo that accepts a face video, streams per-chunk heart-rate estimates via Server-Sent Events, and renders them in a React UI (no build step — Babel transpiles JSX in the browser).

**Stub mode:** the backend currently emits deterministic fake BPM data. Real rPPG model integration is being developed separately and will replace `pipeline/chunker.py`.

## Run locally

Run all commands from the `app/` directory.

```bash
# 1. Create a virtual environment
uv venv

# 2. Install dependencies
uv pip install -r requirements.txt

# 3. Start the server
uv run python main.py
```

Then open `http://localhost:8000` in your browser.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | Serves `static/index.html` |
| `POST` | `/api/analyze` | Accepts `multipart/form-data` video upload, returns `{"job_id": "<uuid>"}` |
| `GET`  | `/api/analyze/{job_id}/stream` | SSE stream: 12 `chunk` events + 1 `final` event |
| `GET`  | `/healthz` | Health check |

## SSE event shapes

**Chunk event** (12 total, ~1.2 s apart):
```json
{"type": "chunk", "idx": 0, "bpm": 72, "quality": 0.91, "latency_ms": 140}
```

**Final event** (after all chunks):
```json
{
  "type": "final",
  "overall_bpm": 76,
  "ci": 2,
  "respiratory_rate": 16,
  "hrv": {"rmssd": 42, "sdnn": 58, "pnn50": 18, "lf_hf": 1.4},
  "perf": {"total_seconds": 18.0, "avg_chunk_seconds": 1.5, "frames_processed": 1800}
}
```
