# Pulse Lab — heart rate from face video, in near real time

Take-home prototype for the Wise AI Full-Stack Integration Engineer (Computer Vision)
role. Take a 60-second face video, get a heart rate estimate streamed back chunk
by chunk using remote photoplethysmography (rPPG).

## Live demo
- **App**: https://pulse-lab.manishsingh.tech
- **Try the bundled sample** by clicking "Analyze sample →" on the landing page.
- **Or upload your own** 60-second face video, or **record one in-browser** via
  the webcam.

## Engineering notes
See [NOTES.md](./NOTES.md) — architecture, performance numbers, failure modes,
and a section on which AI tools were used during the build (the brief asks
for this explicitly).

## Run locally
```
cd app
uv sync
uv run python main.py
```

Open `http://localhost:8000`. First boot warms JAX (~5-10s). To skip the
heavy model load during UI iteration: `STUB_MODE=1 uv run python main.py`.

## Stack
FastAPI · open-rppg (FacePhys.rlap, JAX backend) · OpenCV · React via CDN
(no build step) · Server-Sent Events for chunk streaming · Dokploy + Traefik
on a Hostinger VM, Cloudflare DNS, Let's Encrypt.

## Repo layout
- `app/` — the running service (backend + bundled frontend + Dockerfile)
- `Research/` — deep-dive notes on open-rppg internals and chunked-rPPG
  best practices (compiled by Haiku research sub-agents during the build)
- `CREDITS.md` — sample video attribution
