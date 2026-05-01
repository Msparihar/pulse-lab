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
   Brand mark + ECG line
   ============================================================ */
function ECG({ width = 220, height = 24 }) {
  const path = "M0,12 L30,12 L36,12 L40,6 L44,18 L48,4 L52,20 L56,12 L90,12 L96,12 L100,8 L104,16 L108,12 L150,12 L156,12 L160,2 L164,22 L168,8 L172,16 L176,12 L220,12";
  return (
    <svg className="ecg" width={width} height={height} viewBox="0 0 220 24" fill="none">
      <path d={path} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function BrandMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <rect x="0.5" y="0.5" width="27" height="27" rx="7" fill="var(--accent-soft)" stroke="oklch(0.85 0.07 25)"/>
      <path d="M4 14 L8 14 L10 10 L12 18 L14 8 L16 16 L18 14 L24 14"
            stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

/* ============================================================
   Header
   ============================================================ */
function Header() {
  return (
    <header className="header">
      <div className="brand">
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
   v2 — Segmented mode toggle inside upload card
   ============================================================ */
function ModeToggle({ value, onChange }) {
  return (
    <div className="seg" role="tablist">
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

  const [camError, setCamError] = useState(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0); // 0..60s

  // Chips are cosmetic for now — hardcoded to "good"
  const chips = { lighting: "good", face: "centered", motion: "low" };

  // Start camera on mount
  useEffect(() => {
    let active = true;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" } })
      .then((stream) => {
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      })
      .catch((err) => {
        if (!active) return;
        console.error("[WebcamCapture] getUserMedia failed", err);
        setCamError("Camera access denied or unavailable.");
      });
    return () => {
      active = false;
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

  const stopRecording = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    setRecording(false);
    setElapsed(0);
  }, []);

  const ringR = 36;
  const ringC = 2 * Math.PI * ringR;
  const dash  = ringC * (elapsed / 60);

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  return (
    <div>
      <div className="webcam">
        {/* Live video preview */}
        <video ref={videoRef} autoPlay muted playsInline/>

        {/* Camera error overlay */}
        {camError && (
          <div className="webcam-error">{camError}</div>
        )}

        {/* Face ROI bbox — centered-ish */}
        {!camError && (
          <div style={{ position: "absolute", left: "32%", top: "16%", width: "36%", height: "62%", zIndex: 2 }}>
            <div className="webcam-roi" style={{ position: "absolute", inset: 0 }}>
              <span className="webcam-roi-corner tl"/>
              <span className="webcam-roi-corner tr"/>
              <span className="webcam-roi-corner bl"/>
              <span className="webcam-roi-corner br"/>
            </div>
          </div>
        )}

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

        {!camError && (
          <button
            className={`webcam-record-btn ${recording ? "is-recording" : ""}`}
            onClick={() => {
              if (recording) {
                stopRecording();
              } else {
                startRecording();
              }
            }}
          >
            {recording ? (
              <span className="tabular">{fmt(60 - elapsed)}</span>
            ) : (
              <span className="webcam-record-btn-inner"/>
            )}
          </button>
        )}
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
          {recording ? "recording…" : "tap to record · 60s"}
        </span>
      </div>
    </div>
  );
}

/* ============================================================
   Upload Zone
   ============================================================ */
function UploadZone({ file, onPickFile, onPickSample, onStart, mode, setMode, onRecordComplete }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onPickFile(f);
  };

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
            onClick={() => inputRef.current?.click()}
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
            <div className="dropzone-glyph">{file ? Icon.film() : Icon.upload()}</div>
            {file ? (
              <>
                <h3>{file.name}</h3>
                <p>Ready to analyze.</p>
                <div className="file-meta tabular">{(file.size / (1024*1024)).toFixed(1)} MB · 60 s · ready</div>
              </>
            ) : (
              <>
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
   v2 — Live BVP waveform
   props:
     bpm      — heart rate, used to drive synthetic wave frequency
     frozen   — if true, render a static snapshot instead of animating
     height   — SVG height in px (default 72)
     samples  — real BVP array from the final SSE event (used when frozen=true)
   ============================================================ */
function LiveWaveform({ bpm = 76, frozen = false, height = 72, samples = [] }) {
  const W = 800, H = height;
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (frozen) return;
    let raf;
    let last = performance.now();
    const tick = (t) => {
      const dt = (t - last) / 1000;
      last = t;
      setPhase(p => p + dt * (W / 10));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frozen]);

  // Frozen path from real BVP samples when available
  const frozenPath = useMemo(() => {
    if (!frozen || samples.length < 2) return null;
    return samples.map((v, i) => {
      const x = (i / (samples.length - 1)) * W;
      const y = H / 2 - v * (H / 2 - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [frozen, samples, H]);

  // Synthetic BVP-ish waveform (used for live mode and frozen fallback)
  const pulsesPerSec = bpm / 60;
  const samplesPerSec = W / 10;
  const period = samplesPerSec / pulsesPerSec;
  const syntheticPath = useMemo(() => {
    let d = "";
    for (let x = 0; x <= W; x += 2) {
      const t = (x + phase) / period;
      const beat = t - Math.floor(t);
      const peak = (b, c, w) => Math.exp(-((b - c) ** 2) / (2 * w * w));
      const y = -(1.0 * peak(beat, 0.18, 0.06) + 0.45 * peak(beat, 0.45, 0.07)) + 0.35;
      const py = H / 2 + y * (H * 0.36);
      d += (x === 0 ? "M" : " L") + x + "," + py.toFixed(1);
    }
    return d;
  }, [phase, period, H]);

  const pathToRender = frozen && frozenPath ? frozenPath : syntheticPath;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={H/2} y2={H/2} stroke="var(--line)" strokeDasharray="2 4" strokeWidth="1"/>
      <path d={pathToRender} stroke="var(--accent)" strokeWidth="1.7" fill="none"
            strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ProcessingView({ file, chunks, runningAvg, currentIdx, total, onCancel, pulsePeriod, bpm, roiLost, showWaveform }) {
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
          {currentIdx < total
            ? <>Currently processing chunk <span className="tabular">{currentIdx + 1}</span> of <span className="tabular">{total}</span></>
            : <>Finalizing…</>}
        </span>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
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
          <div className="result-label">Overall BPM</div>
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
                {biomarkers.rr != null ? biomarkers.rr : "—"}
                {biomarkers.rr != null && <span className="biomarker-unit">br/min</span>}
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
function WholeFailure({ onRetry, onSample }) {
  return (
    <div className="card" data-screen-label="04 Failure">
      <div className="failure">
        <div className="failure-glyph">{Icon.alert(20)}</div>
        <h3>We couldn't find a face in this video</h3>
        <p>
          The rPPG model needs a clearly-lit, mostly-still face for the full 60 seconds.
          Try a video with steadier framing, or use our sample to see how it works.
        </p>
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
  ModeToggle, WebcamCapture,
  UploadZone, ProcessingView, ResultsView, WholeFailure,
  LiveWaveform, ProcThumbRoi,
});
