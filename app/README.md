# Pulse Lab — rPPG Demo

A FastAPI-backed demo that accepts a face video, streams per-chunk heart-rate estimates via Server-Sent Events, and renders them in a React UI (no build step — Babel transpiles JSX in the browser).

**Stub mode:** the backend currently emits deterministic fake BPM data. Real rPPG model integration is being developed separately and will replace `pipeline/chunker.py`.

## Run locally

From the `app/` directory:

```
uv sync
uv run python main.py
```

`uv sync` creates a `.venv` and installs everything from `pyproject.toml` (it'll generate `uv.lock` on first run). `uv run` executes inside that venv without needing to activate it.

The first launch warms up JAX (5–10s); after `Ready.` you can hit http://localhost:8000.

To skip model loading during UI iteration:

```
STUB_MODE=1 uv run python main.py
```

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
