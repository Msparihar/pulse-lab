# Near Real-Time rPPG Integration

Take-home for **Wise AI — Full-Stack Integration Engineer (Computer Vision)**.
Deadline: Sunday, 3 May 2026.

## Brief

Build a small prototype that takes a 60-second face video as input, processes
it in 5-second chunks, and generates:

- BPM estimate per 5-second chunk
- Overall BPM estimate for the full 60 seconds
- Basic runtime / performance metrics

Bonus: respiratory rate or other biomarkers.

## Stack

- **Frontend**: Next.js (App Router) + TypeScript, Zustand for client state,
  React Query for data fetching.
- **Backend**: Python 3.11 + FastAPI. OpenCV for frame I/O. One of the
  open-source rPPG models below as the inference layer (likely
  `rPPG-Toolbox` — most actively maintained, multiple algorithms shipped).
- **Streaming**: Server-Sent Events from the backend so the UI can render
  per-chunk BPM as soon as each 5-second window finishes processing.

## Candidate Models

- https://github.com/KegangWangCCNU/open-rppg — HR + RR
- https://github.com/ubicomplab/rPPG-Toolbox — HR + RR (preferred)
- https://github.com/prouast/heartbeat — HR
- https://github.com/eugenelet/Meta-rPPG — HR

## Deliverables

- Hosted prototype link (or local repro instructions)
- Sample output: per-chunk BPM + final BPM
- Notes on accuracy, latency, failure cases
- Notes on AI tools used during build

## Plan

1. UI design via Claude Design → review → lock visuals.
2. Backend skeleton: upload endpoint, chunking, SSE for results.
3. Wire chosen rPPG model, validate against a known sample.
4. Frontend: upload, live chunk readout, final summary, perf metrics.
5. Polish, write notes, deploy.
