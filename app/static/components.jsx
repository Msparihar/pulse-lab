/* global React */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ============================================================
   Icons
   ============================================================ */
const Icon = {
  upload: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M7 9l5-5 5 5"/>
      <path d="M5 20h14"/>
    </svg>
  ),
  film: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2"/>
      <path d="M7 4v16M17 4v16M3 10h4M17 10h4M3 14h4M17 14h4"/>
    </svg>
  ),
  alert: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 8v4M12 16h.01"/>
    </svg>
  ),
  heart: (s = 22) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21s-7-4.35-9.5-9.13C.85 8.5 2.5 4.5 6.2 4.5c2.05 0 3.4 1.05 4.3 2.5h.5c.9-1.45 2.25-2.5 4.3-2.5 3.7 0 5.35 4 3.7 7.37C19 16.65 12 21 12 21z"/>
    </svg>
  ),
};

/* ============================================================
   Brand mark + ECG line (v2: animated beat-schedule ECG)
   ============================================================ */
function ECG({ width = 220, height = 24 }) {
  // Animated heartbeat with natural irregularity:
  //  - per-beat jitter on cadence (RR interval), R-spike amplitude, T amplitude
  //  - tiny baseline wander so the line breathes
  //  - the occasional slightly-early/late beat
  const [phase, setPhase] = useState(0);
  // Beats live in a ref so they survive re-renders and accumulate as we scroll.
  // Each beat = { x: pixel position of its R-spike, rAmp, tAmp, period }
  const beatsRef = useRef(null);

  const W = 220, H = 24;
  const mid = H / 2;
  const speed = 22; // px/sec

  // Initialize a couple of beats off the right edge
  if (beatsRef.current === null) {
    const seed = [];
    let x = -10;
    while (x < W + 80) {
      const period = 58 + (Math.random() - 0.5) * 14; // 51..65 px between beats
      x += period;
      seed.push({
        x,
        period,
        rAmp: 8 + Math.random() * 2.5,         // 8..10.5
        tAmp: 2 + Math.random() * 1.2,         // 2..3.2
        pAmp: 1 + Math.random() * 0.6,
      });
    }
    beatsRef.current = seed;
  }

  useEffect(() => {
    let raf;
    let last = performance.now();
    const tick = (t) => {
      const dt = (t - last) / 1000;
      last = t;
      // Scroll all beats left
      const beats = beatsRef.current;
      for (let i = 0; i < beats.length; i++) beats[i].x -= speed * dt;
      // Drop beats fully off the left
      while (beats.length && beats[0].x < -20) beats.shift();
      // Add new beats off the right when we're running thin
      while (beats[beats.length - 1].x < W + 80) {
        const last = beats[beats.length - 1];
        // Skip a beat occasionally (PVC-style pause), or run a slightly fast one
        const roll = Math.random();
        let period;
        if (roll < 0.06)      period = last.period * (1.25 + Math.random() * 0.15); // long pause
        else if (roll < 0.14) period = last.period * (0.78 + Math.random() * 0.08); // early beat
        else                  period = 58 + (Math.random() - 0.5) * 14;
        beats.push({
          x: last.x + period,
          period,
          rAmp: 8 + Math.random() * 2.5,
          tAmp: 2 + Math.random() * 1.2,
          pAmp: 1 + Math.random() * 0.6,
        });
      }
      setPhase(p => p + dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const path = useMemo(() => {
    const beats = beatsRef.current || [];
    // Sample y(x) at every pixel by finding the nearest beat and applying its waveform
    let d = "";
    let started = false;
    for (let x = 0; x <= W; x += 1) {
      // tiny baseline wander (slow sin) — purely cosmetic
      const wander = Math.sin((x * 0.05) + phase * 0.6) * 0.25;
      // Find the beat whose R-spike is nearest to x
      let nearest = null;
      let nd = Infinity;
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        const d2 = x - b.x;
        if (Math.abs(d2) < nd) { nd = Math.abs(d2); nearest = b; }
      }
      let y = mid + wander;
      if (nearest) {
        const u = x - nearest.x; // signed offset from R-spike (px)
        // Waveform shape relative to R-spike at u=0:
        //   P wave:  u in [-14, -10]  small bump up
        //   PR:      u in [-10, -3]   flat
        //   Q:       u in [-3, -1]    small dip down (positive y)
        //   R:       u in [-1, 1]     tall spike up (negative y)
        //   S:       u in [1, 3]      dip down
        //   ST:      u in [3, 7]      flat
        //   T wave:  u in [7, 16]     medium bump up
        if (u >= -14 && u < -10)     y -= nearest.pAmp * Math.sin(((u + 14) / 4) * Math.PI);
        else if (u >= -3  && u < -1) y += 1.2 * ((u + 3) / 2);
        else if (u >= -1  && u <  1) y -= nearest.rAmp * Math.cos((u) * Math.PI / 2);
        else if (u >=  1  && u <  3) y += 4.2 * (1 - (u - 1) / 2);
        else if (u >=  7  && u < 16) y -= nearest.tAmp * Math.sin(((u - 7) / 9) * Math.PI);
      }
      d += (started ? " L" : "M") + x + "," + y.toFixed(2);
      started = true;
    }
    return d;
  }, [phase]);

  return (
    <svg className="ecg" width={width} height={height} viewBox={`0 0 ${W} ${H}`} fill="none">
      <path d={path} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function BrandMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <rect x="0.5" y="0.5" width="27" height="27" rx="7" fill="var(--accent-soft)" stroke="color-mix(in oklch, var(--accent) 30%, var(--bg))"/>
      <path d="M4 14 L8 14 L10 10 L12 18 L14 8 L16 16 L18 14 L24 14"
            stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

/* ============================================================
   Header
   ============================================================ */
function Header({ onHome }) {
  return (
    <header className="header">
      <div
        className="brand"
        role={onHome ? "button" : undefined}
        tabIndex={onHome ? 0 : undefined}
        onClick={onHome}
        onKeyDown={onHome ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onHome(); } } : undefined}
        style={onHome ? { cursor: "pointer" } : undefined}
        aria-label={onHome ? "Pulse Lab — back to home" : undefined}
      >
        <BrandMark/>
        <div>
          <div className="brand-name">Pulse Lab</div>
          <div className="brand-sub">Heart rate from face video, in near real time.</div>
        </div>
      </div>
      <ECG/>
    </header>
  );
}

/* ============================================================
   v2 — Sample-first hero player
   ============================================================ */
// Bundled sample face video (VitalLens, MIT license — see CREDITS.md).
// Same file the backend analyzes when "Analyze sample →" is clicked, so the
// preview the user plays is exactly what gets processed. Same-origin → no
// CORS / hotlink issues, and ~1 MB so it loads instantly.
const SAMPLE_VIDEO_URL = "/static/samples/sample-face-60s.mp4";

function SampleHero({ onAnalyze, onPickFile, onRecord }) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(60);
  const inputRef = useRef(null);

  const fmt = (s) => {
    if (!isFinite(s)) s = 0;
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  };

  return (
    <div data-screen-label="01 Upload">
      <div className={`sample-hero ${playing ? "is-playing" : ""}`}>
        <div className="sample-hero-roi"><span/><span/></div>
        <span className="sample-hero-tag">Sample · 60s face video</span>
        <video
          ref={videoRef}
          src={SAMPLE_VIDEO_URL}
          controls
          playsInline
          preload="metadata"
          loop
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => setDuration(e.target.duration || 60)}
          onTimeUpdate={(e) => setTime(e.target.currentTime)}
        />
      </div>
      <div className="sample-hero-progress">
        <div className="sample-hero-progress-fill"
             style={{ width: `${Math.min(100, (time / Math.max(1, Math.min(duration, 60))) * 100)}%` }}/>
      </div>

      <div className="sample-meta">
        <div className="sample-meta-title">
          <h3>Bundled sample · clear face, even lighting</h3>
          <p>Press play to preview, then run the live rPPG analysis on it.</p>
        </div>
        <div className="sample-meta-actions">
          <button className="btn btn-ghost" style={{ padding: "8px 14px" }} onClick={() => {
            const v = videoRef.current;
            if (v) { v.currentTime = 0; v.play(); }
          }}>↺ Replay</button>
          <button className="btn btn-primary" onClick={onAnalyze}>
            Analyze sample →
          </button>
        </div>
      </div>

      <div className="sample-divider">or use your own video</div>

      <input
        ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPickFile(f);
        }}
      />
      <div className="alt-row">
        <button className="alt-tile" onClick={() => inputRef.current?.click()}>
          <span className="alt-tile-head">
            {Icon.upload(16)} Upload a video
          </span>
          <span className="alt-tile-sub">
            60-second .mp4 or .mov, up to 100 MB
          </span>
        </button>
        <button className="alt-tile" onClick={onRecord}>
          <span className="alt-tile-head">
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }}/>
            Record with webcam
          </span>
          <span className="alt-tile-sub">
            Live 60-second capture, then chunked analysis
          </span>
        </button>
      </div>

      <div className="howitworks" style={{ marginTop: 28 }}>
        <span className="howitworks-step">
          <span className="howitworks-num">1</span> 60-second video
        </span>
        <span className="howitworks-arrow">→</span>
        <span className="howitworks-step">
          <span className="howitworks-num">2</span> twelve 5-second chunks
        </span>
        <span className="howitworks-arrow">→</span>
        <span className="howitworks-step">
          <span className="howitworks-num">3</span> per-chunk BPM, streamed
        </span>
        <span className="howitworks-arrow">→</span>
        <span className="howitworks-step">
          <span className="howitworks-num">4</span> final estimate
        </span>
      </div>
    </div>
  );
}

/* ============================================================
   v2 — Video preview modal (UI shell; real playback is a future TODO)
   ============================================================ */
function VideoPreviewModal({ file, onClose }) {
  return (
    <div className="video-modal-backdrop" onClick={onClose}>
      <div className="video-modal" onClick={(e) => e.stopPropagation()}>
        <div className="video-modal-head">
          <h4>{file?.name || "preview"}</h4>
          <button className="video-modal-close" onClick={onClose}>Close</button>
        </div>
        <div className="video-modal-frame">
          <div className="video-modal-mock">
            <div style={{ fontSize: 28, opacity: 0.85 }}>▸</div>
            <div>preview · 60s · 16:9</div>
          </div>
        </div>
        <div className="video-modal-controls">
          <button className="btn btn-ghost" style={{ padding: "6px 10px" }}>▸ Play</button>
          <span className="video-modal-time tabular">00:00</span>
          <div className="scrubber"><div className="scrubber-fill"/></div>
          <span className="video-modal-time tabular">01:00</span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   v2 — Segmented mode toggle inside upload card
   ============================================================ */
function ModeToggle({ value, onChange }) {
  return (
    <div className="seg" role="tablist">
      <button
        className={`seg-btn ${value === "sample" ? "is-active" : ""}`}
        onClick={() => onChange("sample")}
        role="tab" aria-selected={value === "sample"}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>
        Sample
      </button>
      <button
        className={`seg-btn ${value === "upload" ? "is-active" : ""}`}
        onClick={() => onChange("upload")}
        role="tab" aria-selected={value === "upload"}
      >
        {Icon.upload(14)} Upload video
      </button>
      <button
        className={`seg-btn ${value === "record" ? "is-active" : ""}`}
        onClick={() => onChange("record")}
        role="tab" aria-selected={value === "record"}
      >
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }}/>
        Record now
      </button>
    </div>
  );
}

/* ============================================================
   v2 — Webcam capture (real getUserMedia + MediaRecorder)
   ============================================================ */
function WebcamCapture({ onComplete }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const tickRef = useRef(null);

  // camState: "pending" | "denied" | "ready"
  const [camState, setCamState] = useState("pending");
  const [camErrorMsg, setCamErrorMsg] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0); // 0..60s

  // Chips are cosmetic for now — hardcoded to "good"
  const chips = { lighting: "good", face: "centered", motion: "low" };

  const requestCamera = useCallback(() => {
    setCamState("pending");
    setCamErrorMsg("");
    navigator.mediaDevices
      .getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" } })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCamState("ready");
      })
      .catch((err) => {
        const isDenied = err.name === "NotAllowedError" || err.name === "PermissionDeniedError";
        setCamErrorMsg(
          isDenied
            ? "Camera access was denied. Allow camera access in your browser and try again."
            : `Camera unavailable: ${err.message}`
        );
        setCamState("denied");
      });
  }, []);

  // Start camera on mount
  useEffect(() => {
    requestCamera();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";

    chunksRef.current = [];
    const recorder = new MediaRecorder(streamRef.current, { mimeType });
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      onComplete?.(blob);
    };

    recorder.start(200); // collect data every 200ms
    setElapsed(0);
    setRecording(true);

    const startTime = performance.now();
    tickRef.current = setInterval(() => {
      const e = (performance.now() - startTime) / 1000;
      const clamped = Math.min(60, e);
      setElapsed(clamped);
      if (e >= 60) {
        clearInterval(tickRef.current);
        tickRef.current = null;
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
        setRecording(false);
      }
    }, 100);
  }, [onComplete]);

  // No manual stop — recording auto-stops at 60s for guaranteed duration.
  // The button is disabled until 60s elapses (or auto-completes).

  const ringR = 36;
  const ringC = 2 * Math.PI * ringR;
  const dash  = ringC * (elapsed / 60);

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  // --- Permission pending state ---
  if (camState === "pending") {
    return (
      <div>
        <div className="webcam webcam-permission">
          <div className="webcam-permission-content">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent)", opacity: 0.85 }}>
              <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
            </svg>
            <p>Allow camera access in your browser to start recording.</p>
          </div>
        </div>
        <div className="webcam-chips">
          <span style={{ fontSize: 12, color: "var(--text-subtle)", fontFamily: "var(--font-mono)" }}>waiting for permission…</span>
        </div>
      </div>
    );
  }

  // --- Permission denied state ---
  if (camState === "denied") {
    return (
      <div>
        <div className="webcam webcam-permission">
          <div className="webcam-permission-content">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)" }}>
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
            <p style={{ color: "var(--text-muted)" }}>{camErrorMsg}</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button className="btn btn-secondary" style={{ fontSize: 13, padding: "8px 16px" }} onClick={requestCamera}>
                Retry
              </button>
            </div>
          </div>
        </div>
        <div className="webcam-chips">
          <span style={{ fontSize: 12, color: "var(--text-subtle)", fontFamily: "var(--font-mono)" }}>camera unavailable</span>
        </div>
      </div>
    );
  }

  // --- Camera ready state ---
  return (
    <div>
      <div className="webcam">
        {/* Live video preview */}
        <video ref={videoRef} autoPlay muted playsInline/>

        {/* Countdown ring */}
        <svg className="webcam-record-ring" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r={ringR} fill="none"
                  stroke="oklch(0.9 0 0 / 0.4)" strokeWidth="2"/>
          {recording && (
            <circle cx="40" cy="40" r={ringR} fill="none"
                    stroke="var(--accent)" strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={`${dash} ${ringC}`}
                    transform="rotate(-90 40 40) scale(-1 1) translate(-80 0)"/>
          )}
        </svg>

        <button
          className={`webcam-record-btn ${recording ? "is-recording" : ""}`}
          onClick={() => { if (!recording) startRecording(); }}
          disabled={recording}
          title={recording ? `Recording — auto-stops at 60s (${fmt(60 - elapsed)} remaining)` : "Start 60-second recording"}
        >
          {recording ? (
            <span className="tabular">{fmt(60 - elapsed)}</span>
          ) : (
            <span className="webcam-record-btn-inner"/>
          )}
        </button>
      </div>

      <div className="webcam-chips">
        <span className="webcam-chip">
          <span className="webcam-chip-dot"/>
          <span className="webcam-chip-label">lighting</span>
          {chips.lighting}
        </span>
        <span className="webcam-chip">
          <span className="webcam-chip-dot"/>
          <span className="webcam-chip-label">face</span>
          {chips.face}
        </span>
        <span className="webcam-chip">
          <span className="webcam-chip-dot"/>
          <span className="webcam-chip-label">motion</span>
          {chips.motion}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-subtle)", fontFamily: "var(--font-mono)" }}>
          {recording ? "recording… auto-stops at 60s" : "tap to record · 60s"}
        </span>
      </div>
    </div>
  );
}

/* ============================================================
   Upload Zone (v2: sample-first landing + video preview modal)
   ============================================================ */
function UploadZone({ file, onPickFile, onPickSample, onStart, mode, setMode, onRecordComplete }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  const previewUrlRef = useRef(null);

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onPickFile(f);
  };

  // Default landing: sample-first hero. Only show legacy dropzone / webcam
  // when user explicitly switches modes.
  if (mode === "sample" && !file) {
    return (
      <div className="card">
        <SampleHero
          onAnalyze={() => { onPickSample(); }}
          onPickFile={(f) => { onPickFile(f); setMode("upload"); }}
          onRecord={() => setMode("record")}
        />
      </div>
    );
  }

  return (
    <div className="card" data-screen-label="01 Upload">
      <ModeToggle value={mode} onChange={setMode}/>

      {mode === "record" ? (
        <>
          <WebcamCapture onComplete={onRecordComplete}/>
          <div className="howitworks">
            <span className="howitworks-step">
              <span className="howitworks-num">1</span> 60-second capture
            </span>
            <span className="howitworks-arrow">→</span>
            <span className="howitworks-step">
              <span className="howitworks-num">2</span> twelve 5-second chunks
            </span>
            <span className="howitworks-arrow">→</span>
            <span className="howitworks-step">
              <span className="howitworks-num">3</span> per-chunk BPM, streamed
            </span>
            <span className="howitworks-arrow">→</span>
            <span className="howitworks-step">
              <span className="howitworks-num">4</span> final estimate
            </span>
          </div>
        </>
      ) : (
        <>
          <div
            className={`dropzone ${drag ? "is-active" : ""} ${file ? "has-file" : ""}`}
            onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
            onDragOver={(e)  => { e.preventDefault(); setDrag(true); }}
            onDragLeave={()  => setDrag(false)}
            onDrop={onDrop}
            onClick={() => { if (!file) inputRef.current?.click(); }}
          >
            <input
              ref={inputRef}
              type="file" accept="video/mp4,video/quicktime,video/webm"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickFile(f);
              }}
            />
            {file ? (
              (() => {
                // Revoke previous blob URL to avoid leaks, then create a fresh one
                if (previewUrlRef.current) { URL.revokeObjectURL(previewUrlRef.current); }
                previewUrlRef.current = URL.createObjectURL(file);
                return (
                  <>
                    <video
                      src={previewUrlRef.current}
                      controls
                      playsInline
                      preload="metadata"
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: "100%", borderRadius: 6, maxHeight: 260, background: "#000" }}
                    />
                    <h3 style={{ marginTop: 10 }}>{file.name}</h3>
                    <p>
                      <button className="link-btn"
                        onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>Replace</button>
                    </p>
                    <div className="file-meta tabular">{(file.size / (1024*1024)).toFixed(1)} MB · ready</div>
                  </>
                );
              })()
            ) : (
              <>
                <div className="dropzone-glyph">{Icon.upload()}</div>
                <h3>Drop a face video, or click to select</h3>
                <p>We'll process it in twelve 5-second chunks.</p>
              </>
            )}
          </div>

          <div className="constraints">
            <span>
              60-second face video
              <span className="dot"></span>
              .mp4 or .mov
              <span className="dot"></span>
              up to 100 MB
            </span>
            <button className="link-btn" onClick={(e) => { e.stopPropagation(); onPickSample(); }}>
              Use sample video
            </button>
          </div>

          <div className="howitworks">
            <span className="howitworks-step">
              <span className="howitworks-num">1</span> 60-second video
            </span>
            <span className="howitworks-arrow">→</span>
            <span className="howitworks-step">
              <span className="howitworks-num">2</span> twelve 5-second chunks
            </span>
            <span className="howitworks-arrow">→</span>
            <span className="howitworks-step">
              <span className="howitworks-num">3</span> per-chunk BPM, streamed
            </span>
            <span className="howitworks-arrow">→</span>
            <span className="howitworks-step">
              <span className="howitworks-num">4</span> final estimate
            </span>
          </div>

          <div className="actions">
            <button className="btn btn-primary" disabled={!file} onClick={onStart}>
              Start analysis
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================
   Processing View
   ============================================================ */
function ChunkTick({ chunk, isActive }) {
  if (!chunk) return null;
  const { idx, bpm, status, quality } = chunk;
  const cls =
    status === "done"    ? "" :
    status === "failed"  ? "is-failed" :
    status === "active"  ? "is-active" : "is-pending";

  const fillPct = bpm ? Math.max(20, Math.min(96, ((bpm - 50) / 60) * 100)) : 0;

  return (
    <div className={`chunk ${cls}`}>
      {status === "done" && (
        <div className="chunk-fill" style={{ height: `${fillPct}%` }} />
      )}
      {isActive && status !== "done" && status !== "failed" && (
        <div className="chunk-fill" />
      )}
      <div className="chunk-bpm tabular">
        {status === "done"   && bpm}
        {status === "failed" && "—"}
      </div>
      <div className="chunk-idx">{String(idx + 1).padStart(2, "0")}</div>

      <div className="chunk-tooltip">
        {status === "done"   && <>chunk {idx+1} · {bpm} bpm · q {quality?.toFixed(2)}</>}
        {status === "failed" && <>chunk {idx+1} · {chunk.failReason || "signal too noisy"}</>}
        {status === "active" && <>chunk {idx+1} · processing…</>}
        {status === "pending"&& <>chunk {idx+1} · waiting</>}
      </div>
    </div>
  );
}

/* ============================================================
   v2 — ROI overlay on processing thumbnail
   ============================================================ */
function ProcThumbRoi({ lost }) {
  const [pos, setPos] = useState({ left: 28, top: 14, w: 36, h: 38 });
  useEffect(() => {
    const id = setInterval(() => {
      setPos({
        left: 26 + Math.random() * 4,
        top:  12 + Math.random() * 4,
        w:    34 + Math.random() * 4,
        h:    36 + Math.random() * 4,
      });
    }, 900);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      className={`proc-thumb-roi ${lost ? "is-lost" : ""}`}
      style={{ left: `${pos.left}%`, top: `${pos.top}%`, width: `${pos.w}%`, height: `${pos.h}%` }}
    />
  );
}

/* ============================================================
   v2 — Live BVP waveform (beat-schedule algorithm)
   props:
     bpm      — heart rate, drives beat frequency
     frozen   — if true, render a static snapshot instead of animating
     height   — SVG height in px (default 72)
     samples  — real BVP array from the final SSE event (used when frozen=true)
   ============================================================ */
function LiveWaveform({ bpm = 76, frozen = false, height = 72, samples = [] }) {
  const W = 800, H = height;
  const [phase, setPhase] = useState(0);

  // px-per-second scroll speed: ~10s of waveform shown across W
  const speed = W / 10;
  // Mean px-per-beat at the current bpm (10s = W px, beats in 10s = bpm/6)
  const meanPeriodPx = W / Math.max(1, (bpm / 60) * 10);

  const beatsRef = useRef(null);

  if (beatsRef.current === null) {
    const seed = [];
    let x = -meanPeriodPx;
    while (x < W + meanPeriodPx * 2) {
      x += meanPeriodPx * (0.88 + Math.random() * 0.24); // ±12%
      seed.push({
        x,
        sysAmp: 0.85 + Math.random() * 0.3,    // 0.85..1.15
        dicAmp: 0.35 + Math.random() * 0.2,    // 0.35..0.55
        baseline: (Math.random() - 0.5) * 0.06, // tiny wander
      });
    }
    beatsRef.current = seed;
  }

  useEffect(() => {
    if (frozen) return;
    let raf;
    let last = performance.now();
    const tick = (t) => {
      const dt = (t - last) / 1000;
      last = t;
      const beats = beatsRef.current;
      const dx = speed * dt;
      for (let i = 0; i < beats.length; i++) beats[i].x -= dx;
      while (beats.length && beats[0].x < -meanPeriodPx) beats.shift();
      while (beats[beats.length - 1].x < W + meanPeriodPx * 2) {
        const last = beats[beats.length - 1];
        // Most beats: ±12% jitter. Occasionally an early beat or longer pause.
        const roll = Math.random();
        let factor;
        if (roll < 0.05)      factor = 1.25 + Math.random() * 0.18; // long pause
        else if (roll < 0.12) factor = 0.78 + Math.random() * 0.08; // premature
        else                  factor = 0.88 + Math.random() * 0.24;
        beats.push({
          x: last.x + meanPeriodPx * factor,
          sysAmp: 0.85 + Math.random() * 0.3,
          dicAmp: 0.35 + Math.random() * 0.2,
          baseline: (Math.random() - 0.5) * 0.06,
        });
      }
      setPhase(p => p + dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frozen, speed, meanPeriodPx]);

  // Frozen path from real BVP samples when available
  const frozenPath = useMemo(() => {
    if (!frozen || samples.length < 2) return null;
    return samples.map((v, i) => {
      const x = (i / (samples.length - 1)) * W;
      const y = H / 2 - v * (H / 2 - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [frozen, samples, H]);

  // Beat-schedule synthetic path (live mode, and frozen fallback when no samples)
  const syntheticPath = useMemo(() => {
    const beats = beatsRef.current || [];
    const peak = (b, c, w) => Math.exp(-((b - c) ** 2) / (2 * w * w));
    let d = "";
    for (let x = 0; x <= W; x += 2) {
      // tiny baseline wander — slow sin
      const wander = Math.sin((x * 0.012) + phase * 0.7) * 0.04;
      // Sum contributions of nearby beats (BVP shape spans ~one period each side)
      let val = wander;
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        const u = (x - b.x) / meanPeriodPx; // normalized offset
        if (u < -0.4 || u > 1.0) continue;   // skip distant beats for perf
        // Two-peak BVP-ish: systolic (u≈0.18) + dicrotic (u≈0.45)
        val -= b.sysAmp * peak(u, 0.18, 0.07);
        val -= b.dicAmp * peak(u, 0.50, 0.09);
        val += b.baseline * peak(u, 0.3, 0.4);
      }
      const py = H / 2 + (val + 0.45) * (H * 0.34);
      d += (x === 0 ? "M" : " L") + x + "," + py.toFixed(1);
    }
    return d;
  }, [phase, meanPeriodPx, H]);

  // Prefer real samples in frozen mode; fall back to synthetic
  const pathToRender = frozen && frozenPath ? frozenPath : syntheticPath;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={H/2} y2={H/2} stroke="var(--line)" strokeDasharray="2 4" strokeWidth="1"/>
      <path d={pathToRender} stroke="var(--accent)" strokeWidth="1.7" fill="none"
            strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ProcessingView({ file, chunks, runningAvg, currentIdx, total, onCancel, pulsePeriod, bpm, roiLost, showWaveform, phase }) {
  return (
    <div className="card" data-screen-label="02 Processing">
      <div className="proc-head">
        <div style={{ display: "flex", alignItems: "center", gap: 16, flex: 1 }}>
          <div className="proc-thumb">
            <span className={`proc-thumb-rec tabular ${roiLost ? "is-dim" : ""}`}>REC</span>
            <ProcThumbRoi lost={roiLost}/>
          </div>
          <div className="proc-meta">
            <div className="proc-meta-label">Source</div>
            <div className="proc-meta-value">{file?.name || "sample.mp4"}</div>
          </div>
        </div>
        <div className="running-avg is-pulsing" style={{ "--pulse-period": `${pulsePeriod}s` }}>
          <div className="running-avg-label">Running average</div>
          <div className="running-avg-num tabular">
            {runningAvg ?? "—"}
            <span className="running-avg-unit">bpm</span>
          </div>
        </div>
      </div>

      <div className="proc-status" style={{ marginTop: 0, marginBottom: 0 }}>
        <span>
          <span className="proc-status-dot"></span>
          {phase === "decoding"
            ? <>Decoding video…</>
            : currentIdx < total
              ? <>Currently processing chunk <span className="tabular">{currentIdx + 1}</span> of <span className="tabular">{total}</span></>
              : <>Finalizing…</>}
        </span>
        <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>

      {showWaveform && (
        <>
          <div className="waveform">
            <LiveWaveform bpm={bpm}/>
            <div className="waveform-fade"/>
          </div>
          <div className="waveform-tickers">
            <span>fps · 30</span>
            <span className="sep">·</span>
            <span>roi · forehead</span>
            <span className="sep">·</span>
            <span>signal · {roiLost ? "lost" : "steady"}</span>
          </div>
        </>
      )}

      <div className="timeline-wrap">
        <div className="timeline-axis">
          <span>00:00</span>
          <span>00:15</span>
          <span>00:30</span>
          <span>00:45</span>
          <span>01:00</span>
        </div>
        <div className="chunks">
          {chunks.map((c, i) => (
            <ChunkTick key={i} chunk={c} isActive={i === currentIdx} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Results — Chart
   ============================================================ */
function PerChunkChart({ chunks }) {
  const W = 480, H = 220;
  const padL = 36, padR = 12, padT = 16, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const valid = chunks.filter(c => c.status === "done");
  const ys = valid.map(c => c.bpm);
  const minY = Math.floor(Math.min(...ys, 60) / 5) * 5;
  const maxY = Math.ceil (Math.max(...ys, 90) / 5) * 5;
  const yRange = maxY - minY;

  const xFor = (i) => padL + (i / 11) * innerW;
  const yFor = (b) => padT + (1 - (b - minY) / yRange) * innerH;

  const [hover, setHover] = useState(null);

  const linePath = useMemo(() => {
    let d = "";
    let started = false;
    chunks.forEach((c, i) => {
      if (c.status !== "done") { started = false; return; }
      const x = xFor(i), y = yFor(c.bpm);
      d += (started ? " L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
      started = true;
    });
    return d;
  }, [chunks, minY, maxY]);

  return (
    <div className="chart">
      <div className="chart-axis-y tabular">
        <span>{maxY}</span>
        <span>{Math.round((maxY+minY)/2)}</span>
        <span>{minY}</span>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {[0, 0.5, 1].map((t, i) => (
          <line key={i}
            x1={padL} x2={W - padR}
            y1={padT + t * innerH} y2={padT + t * innerH}
            stroke="var(--line)" strokeWidth="1"
            strokeDasharray={t === 0.5 ? "2 4" : ""}
          />
        ))}

        {[0, 3, 6, 9, 11].map((i) => (
          <line key={i}
            x1={xFor(i)} x2={xFor(i)}
            y1={padT} y2={padT + innerH}
            stroke="var(--line)" strokeDasharray="2 4" strokeWidth="1"
          />
        ))}

        {linePath && (
          <path
            d={`${linePath} L${xFor(11)},${padT+innerH} L${xFor(0)},${padT+innerH} Z`}
            fill="var(--accent-soft)" opacity="0.6"
          />
        )}

        {linePath && (
          <path d={linePath} stroke="var(--accent)" strokeWidth="2"
                fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        )}

        {chunks.map((c, i) => {
          if (c.status === "failed") {
            return (
              <g key={i}
                 onMouseEnter={() => setHover({ i, c, x: xFor(i), y: padT + innerH/2 })}
                 onMouseLeave={() => setHover(null)}>
                <line x1={xFor(i)-4} y1={padT+innerH-4} x2={xFor(i)+4} y2={padT+innerH+4}
                      stroke="var(--text-subtle)" strokeWidth="1.4" strokeLinecap="round"/>
                <line x1={xFor(i)+4} y1={padT+innerH-4} x2={xFor(i)-4} y2={padT+innerH+4}
                      stroke="var(--text-subtle)" strokeWidth="1.4" strokeLinecap="round"/>
                <rect x={xFor(i)-12} y={padT} width="24" height={innerH}
                      fill="transparent"/>
              </g>
            );
          }
          if (c.status !== "done") return null;
          return (
            <g key={i}
               onMouseEnter={() => setHover({ i, c, x: xFor(i), y: yFor(c.bpm) })}
               onMouseLeave={() => setHover(null)}
               style={{ cursor: "pointer" }}>
              <circle cx={xFor(i)} cy={yFor(c.bpm)} r="4.5"
                      fill="var(--bg-elev)" stroke="var(--accent)" strokeWidth="1.8"/>
              <rect x={xFor(i)-12} y={padT} width="24" height={innerH}
                    fill="transparent"/>
            </g>
          );
        })}

        {hover && (
          <line x1={hover.x} x2={hover.x} y1={padT} y2={padT + innerH}
                stroke="var(--accent)" strokeOpacity="0.3" strokeWidth="1"/>
        )}
      </svg>

      <div className="chart-axis-x tabular">
        <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span>
        <span>7</span><span>8</span><span>9</span><span>10</span><span>11</span><span>12</span>
      </div>

      {hover && (
        <div className="chart-hover-card"
             style={{
               left: `${(hover.x / W) * 100}%`,
               top:  `${(hover.y / H) * 100}%`,
             }}>
          <div className="hc-row"><span className="hc-label">chunk</span><span>{hover.i + 1}</span></div>
          {hover.c.status === "done" ? (
            <>
              <div className="hc-row"><span className="hc-label">bpm</span><span>{hover.c.bpm}</span></div>
              <div className="hc-row"><span className="hc-label">quality</span><span>{hover.c.quality.toFixed(2)}</span></div>
            </>
          ) : (
            <div className="hc-row"><span className="hc-label">status</span><span>{hover.c.failReason || "no signal"}</span></div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Results View
   ============================================================ */
function ResultsView({ chunks, perf, overallBpm, ci, biomarkers, pulsePeriod, file, onReset, bvp }) {
  const ciWarn = ci != null && ci > 5;
  return (
    <div className="card" data-screen-label="03 Results">
      <div className="results-grid">
        <div>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div className="result-label">Overall BPM</div>
            <button className="btn btn-secondary" onClick={onReset} style={{ fontSize: 12, padding: "6px 12px", flexShrink: 0 }}>
              New analysis
            </button>
          </div>
          <div className="result-num-wrap">
            <div className="result-num is-pulsing tabular" style={{ "--pulse-period": `${pulsePeriod}s` }}>
              {overallBpm}
              <span className="result-num-unit">bpm</span>
            </div>
            {ci != null && (
              <span className={`ci-badge tabular ${ciWarn ? "is-warn" : ""}`}>
                {ciWarn && <span className="ci-badge-dot"/>}
                ± {ci} bpm
              </span>
            )}
          </div>
          <div className="result-caption">
            95% confidence interval across 12 chunks, weighted by signal quality.
            {ciWarn && <> — consider re-recording in better conditions.</>}
          </div>
        </div>

        <div>
          <div className="result-label" style={{ marginBottom: 0 }}>Per-chunk BPM</div>
          <PerChunkChart chunks={chunks}/>
        </div>
      </div>

      {/* Source snapshot with frozen mini waveform */}
      <div className="source-snapshot">
        <div className="proc-thumb">
          <span className="proc-thumb-rec tabular">SRC</span>
          <ProcThumbRoi/>
        </div>
        <div className="source-snapshot-meta">
          <div className="proc-meta-label">Source</div>
          <div className="proc-meta-value">{file?.name || "sample.mp4"}</div>
        </div>
        <div className="source-snapshot-mini">
          <LiveWaveform bpm={overallBpm} frozen height={36} samples={bvp ?? []}/>
        </div>
      </div>

      <span className="strip-title">Performance</span>
      <div className="perf">
        <div className="perf-card">
          <div className="perf-label">Total processing time</div>
          <div className="perf-value tabular">{perf.total}<span className="perf-unit">s</span></div>
        </div>
        <div className="perf-card">
          <div className="perf-label">Avg per-chunk latency</div>
          <div className="perf-value tabular">{perf.avg}<span className="perf-unit">s</span></div>
        </div>
        <div className="perf-card">
          <div className="perf-label">Frames processed</div>
          <div className="perf-value tabular">{perf.frames.toLocaleString()}</div>
        </div>
      </div>

      {biomarkers && (
        <>
          <span className="strip-title">Biomarkers</span>
          <div className="biomarkers">
            <div className="biomarker-card">
              <div className="biomarker-label">Respiratory rate</div>
              <div className="biomarker-value tabular">
                {(biomarkers.rr != null && biomarkers.rr !== 0) ? biomarkers.rr : "—"}
                {(biomarkers.rr != null && biomarkers.rr !== 0) && <span className="biomarker-unit">br/min</span>}
              </div>
            </div>
            <div className="biomarker-card">
              <div className="biomarker-label">HRV — RMSSD</div>
              <div className="biomarker-value tabular">
                {biomarkers.rmssd != null ? biomarkers.rmssd : "—"}
                {biomarkers.rmssd != null && <span className="biomarker-unit">ms</span>}
              </div>
              <div className="biomarker-caption">beat-to-beat variability</div>
            </div>
            <div className="biomarker-card">
              <div className="biomarker-label">HRV — SDNN</div>
              <div className="biomarker-value tabular">
                {biomarkers.sdnn != null ? biomarkers.sdnn : "—"}
                {biomarkers.sdnn != null && <span className="biomarker-unit">ms</span>}
              </div>
              <div className="biomarker-caption">long-window variability</div>
            </div>
            <div className="biomarker-card">
              <div className="biomarker-label">LF / HF ratio</div>
              <div className="biomarker-value tabular">
                {biomarkers.lfhf != null ? biomarkers.lfhf : "—"}
              </div>
              <div className="biomarker-caption">autonomic balance</div>
            </div>
          </div>
        </>
      )}

      <div className="results-footer">
        <button className="btn btn-secondary" onClick={onReset}>New analysis</button>
      </div>
    </div>
  );
}

/* ============================================================
   Whole-video failure
   ============================================================ */
function WholeFailure({ onRetry, onSample, message }) {
  const defaultMsg = "The rPPG model needs a clearly-lit, mostly-still face for the full 60 seconds. Try a video with steadier framing, or use our sample to see how it works.";
  return (
    <div className="card" data-screen-label="04 Failure">
      <div className="failure">
        <div className="failure-glyph">{Icon.alert(20)}</div>
        <h3>{message ? "Analysis failed" : "We couldn't find a face in this video"}</h3>
        <p>{message || defaultMsg}</p>
        <div className="failure-actions">
          <button className="btn btn-secondary" onClick={onRetry}>Try another video</button>
          <button className="link-btn" onClick={onSample}>Use sample video</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Export everything to window
   ============================================================ */
Object.assign(window, {
  Icon, ECG, BrandMark, Header,
  SampleHero, VideoPreviewModal,
  ModeToggle, WebcamCapture,
  UploadZone, ProcessingView, ResultsView, WholeFailure,
  LiveWaveform, ProcThumbRoi,
});
