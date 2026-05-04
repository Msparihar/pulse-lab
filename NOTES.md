# Pulse Lab — Engineering Notes

## Live demo
- App: https://pulse-lab.manishsingh.tech
- Repo: https://github.com/Msparihar/pulse-lab
- Sample flow: hit "Analyze sample →" on the landing page; the bundled 60s
  face video runs through the full pipeline.

## Architecture (one screen)
- **Backend**: FastAPI single service. Lazy-loads open-rppg's FacePhys.rlap
  model at startup, pre-warms JAX with a dummy 60-frame inference so the
  first user request doesn't pay the 5-10s XLA compile cost.
- **Frontend**: Single-page React via CDN + Babel — no build step. Kept
  intentionally simple so the demo is `git clone && uv sync && uv run python main.py`.
  Pulse Lab is a take-home, not a Next.js codebase to ship.
- **Pipeline** (`pipeline/chunker.py`):
  1. Decode upload, resample to 30fps via frame-index selection
  2. Slice into 12 disjoint 5s windows (150 frames each)
  3. For each window: model.process_video_tensor → BPM, SQI, BVP segment, HRV bundle
  4. Stream each chunk to the browser as it completes (Server-Sent Events)
  5. After the last chunk: SQI-weighted median for overall BPM, averaged HRV
     across valid chunks (SQI > 0.5), tail of concatenated BVPs for the
     frozen waveform on the results screen
- **Why per-chunk-only aggregation** (no whole-video pass): the whole-video
  pass took ~30-40s on top of the chunk pipeline and produced a dead-air
  middle in the user-facing UX. SQI-weighted median across 12 chunks is
  documented in chunked-rPPG literature as competitive with whole-video for
  HR estimation; HRV precision drops slightly. Tradeoff worth it for the
  near-real-time UX the brief grades on.

## Performance (measured against the bundled sample, Docker container, CPU-only)
Numbers below are from a live end-to-end SSE trace (post-warmup, so no XLA compile cost):

- **Total pipeline**: 14.6s for a 60s video (server-reported `perf.total_seconds`)
- **Avg per-chunk latency**: 0.6s (`perf.avg_chunk_seconds`); first chunk 794ms
  (slightly slower — model state settling), subsequent chunks 524-613ms
- **Frames processed**: 1800 (60s @ 30fps, all 12 chunks completed)
- **Overall BPM**: 60 bpm (SQI-weighted median across all 12 chunks; individual
  chunks ranged 56-64 bpm, CI ± 1 bpm)
- **Cold-start tax**: 5-10s JAX XLA compile on the first request after a
  container restart. Mitigated by a startup warmup that runs a dummy
  inference before the server starts accepting requests.
- **Frontend → first chunk visible**: ~1s after upload completes (server sends
  chunk[0] immediately when the window finishes, no batching)
- **Last chunk → final results**: <500ms (no whole-video pass)

## Failure modes + mitigations
| Failure | What happens | Mitigation |
|---|---|---|
| Lighting variance / shadows | SQI drops below 0.293, chunk marked failed (greyed in UI with "signal too noisy" tooltip) | UI shows the failure transparently; final BPM excludes failed chunks from the weighted median |
| Subject motion | Same — SQI degradation | Same |
| No face detected in a chunk | model.process_video_tensor returns None | Marked as failed in UI, chunk timeline shows "no signal" |
| Skin tone bias | rPPG models are documented to underperform on darker skin tones (see Nuralogix and others) | Acknowledged limitation; not mitigated in this prototype. A production version would test on diverse subjects and consider model retraining or contrast normalization |
| Recording shorter than 30s | Backend rejects with HTTP 400 ("Video too short — need at least 30 seconds") | Frontend shows the server's error message in the failure card; webcam capture is hard-locked to 60s auto-stop |
| Container cold-start | First request after idle pays JAX warmup | Pre-warmed at startup; mitigation only covers the first request after the container itself starts. Dokploy keeps containers up so this is rare in practice |
| Looped sample | Respiratory rate extraction breaks across loop boundaries (returns 0) | Sample is a 21s clip looped to 60s for demo convenience. Real recordings don't have this issue. UI shows "—" instead of "0" |

## AI tooling used during build
- **Claude Code (this conversation)** — orchestration, code review, file edits,
  agent delegation, deployment automation
- **Claude Design** — generated the v2 UI prototype (Pulse Lab branding, layout,
  design tokens, component breakdown). Two iterative passes: v1 for the core
  states (upload / processing / results / failure), v2 added biomarker panel,
  CI badge, webcam capture mode, sample-first landing
- **Sub-agents (Sonnet)** — delegated to specialized sub-agents for: porting
  the JSX from Claude Design to the running app, building the Dockerfile,
  Dokploy + Cloudflare deploy, README/notes write-up. Main thread kept
  decisions and code review
- **Sub-agents (Haiku)** — research-only: deep-read of the open-rppg API
  and threading model, chunked-rPPG best-practices literature review
  (SQI thresholds, window sizes, aggregation strategies). Findings are in
  `Research/open-rppg-deep-dive.md` and `Research/chunked-rppg-best-practices.md`
- **Total wall-clock**: about 6 hours from "got the brief" to "live URL with
  passing end-to-end test"

## Stack choices and the why behind them
- **Python**: every open-source rPPG model in the brief is Python (PyTorch /
  JAX). Re-implementing inference in Go would have eaten the timeline.
- **open-rppg over rPPG-Toolbox**: open-rppg is newer, has a cleaner async API,
  ships 17 model variants pre-bundled in the wheel (no weight-download dance),
  and exposes per-chunk BVP / HRV directly. rPPG-Toolbox is more comprehensive
  but heavier setup.
- **Babel-via-CDN over Next.js**: the Claude Design output was already a
  self-contained React-via-CDN app. Porting to Next.js would have added hours
  of scaffolding for no real demo benefit. In production: build the React
  statically and serve from a CDN; the FastAPI service stays the same.
- **SSE over WebSockets**: server-push is one-way (server → browser), no
  backchannel needed. SSE is simpler, automatically reconnects, plays nicely
  with HTTP/2.

## Known gaps / what I'd do next
- Replace the looped sample with a non-looped 60s clip from UBFC-rPPG so
  respiratory rate works on the demo (current sample is 21s looped, which
  breaks RR extraction at loop boundaries)
- Real-time BVP waveform during processing (currently shows the frozen waveform
  only on the results screen)
- Skin-tone bias evaluation: deliberately test the pipeline on diverse subjects
- Per-region face ROI heatmap on the results screen — show which patches of
  the face contributed most to the signal
- Consider GPU acceleration: 5-10x speedup with CUDA. Hostinger VM is CPU-only;
  for production this would be the obvious next infra investment
- Webcam recording preview before submission: currently auto-submits after 60s.
  Adding a "Use this recording / Re-record" step would reduce accidental
  submissions of low-quality recordings

## Post-mortem: SSE buffering bug + decode-latency fix (2026-05-04)

**Symptom.** During the live demo, the processing screen stalled at "chunk 1 of
12" for the full duration. The backend logs showed all 12 chunks completing on
schedule; the browser saw nothing past the first event. Classic split-brain: the
server thought it was streaming, the client thought it was waiting.

**What I did during the call.** I didn't attempt a hot-fix. The risk of breaking
the demo mid-presentation exceeded the value of the demo running. Instead I
pivoted to local benchmark numbers and walked through the architecture — the
pipeline design, the streaming model, the per-chunk BPM chart — using the numbers
from a local run. That was the right call: a fumbled live fix would have consumed
the remaining time and likely failed anyway.

**Diagnosis.** After the call I instrumented both sides with structured tagged
logs: `[BOOT]`, `[JOB]`, `[CHUNK]`, `[SSE]`, `[DECODE]` on the backend and
`[SSE-FE]` on the frontend via `console.info`. Deployed, reproduced, and read the
logs. The backend was yielding chunks in real-time — `[SSE] Yielded` entries
appeared at 570ms intervals, total 13.7s end-to-end. The browser's `[SSE-FE]`
logs showed chunk 0 landing immediately, then silence. The bug was therefore
between the Python `yield` and the browser's `EventSource` — not in the
application. Almost certainly Traefik buffering: the reverse proxy was holding
chunks until its internal buffer filled or the stream closed, then flushing
everything at once. Adding `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no` response headers resolved it.

**Second issue, surfaced by the same logs.** Time-to-first-chunk was 5.4 seconds
of dead air. The decoder was reading all 1800 frames into memory as a single
NumPy array before any inference began. Peak RSS hit 414 MB. The streaming we
advertised wasn't streaming at the decode layer — only at the inference layer.

**Fix shipped.** Streaming chunk-by-chunk decode: `cv2.VideoCapture` is driven
one 150-frame window at a time from a thread pool. Chunk N+1 decodes on the CPU
while chunk N runs through JAX inference. Time-to-first-chunk dropped from 5.4s
to ~0.4s (13x improvement). Peak memory dropped from 414 MB to ~35 MB per chunk
in flight (12x). Expected total pipeline time: 12.4s → 7-8s. Both changes ship
in the same commit.

**Lesson.** Observability mattered more than the fix. Instrumenting the stack
with tagged logs took about an hour. That hour turned "it's broken somewhere
between the server and the browser" into a precise root cause — and surfaced the
decode-latency problem as a free second finding from the same dataset. If I had
shipped a speculative Traefik config change without the logs, I'd have fixed the
buffering but never discovered the 5.4s dead air or the 414 MB memory spike.
Production systems emit the truth; you just have to add the listeners.

**Next steps.** Phase 2 is vmap batching — run all 12 chunks through JAX in a
single batched call instead of sequentially. Target: ~3-4s total on CPU. After
that, GPU for production scale (5-10x over CPU, straightforward with a CUDA
instance).
