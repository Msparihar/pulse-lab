/* global React */
const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ============================================================
   Chunk helpers
   ============================================================ */
function buildInitialChunks() {
  return Array.from({ length: 12 }, (_, i) => ({
    idx: i, bpm: null, quality: null, status: "pending", failReason: null,
  }));
}

/* ============================================================
   App
   ============================================================ */
function App() {
  const [view, setView]         = useState("upload"); // upload | processing | results | failure
  const [file, setFile]         = useState(null);     // real File object or null
  const [chunks, setChunks]     = useState(buildInitialChunks());
  const [currentIdx, setCurrentIdx] = useState(0);
  const [final, setFinal]       = useState(null);     // final SSE payload
  const [uploadMode, setUploadMode] = useState("upload"); // upload | record
  const esRef = useRef(null);

  // Pin coral accent on mount (one-time)
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--accent",      "oklch(0.68 0.18 25)");
    r.setProperty("--accent-soft", "oklch(0.95 0.04 25)");
    r.setProperty("--accent-ink",  "oklch(0.45 0.16 25)");
    r.setProperty("--accent-glow", "oklch(0.68 0.18 25 / 0.18)");
  }, []);

  // Clean up SSE on unmount
  useEffect(() => () => { esRef.current?.close(); }, []);

  /* --------- SSE machinery (shared by upload and sample paths) --------- */
  const openStream = useCallback((job_id) => {
    const es = new EventSource(`/api/analyze/${job_id}/stream`);
    esRef.current = es;

    es.addEventListener("chunk", (ev) => {
      const data = JSON.parse(ev.data);
      setChunks((prev) => {
        const next = prev.slice();
        if (data.failed) {
          next[data.idx] = { ...next[data.idx], status: "failed", failReason: data.reason ?? "signal too noisy" };
        } else {
          next[data.idx] = { ...next[data.idx], status: "done", bpm: data.bpm, quality: data.quality };
        }
        if (data.idx + 1 < 12) {
          next[data.idx + 1] = { ...next[data.idx + 1], status: "active" };
        }
        return next;
      });
      setCurrentIdx(data.idx + 1);
    });

    es.addEventListener("final", (ev) => {
      const d = JSON.parse(ev.data);
      setFinal(d);
      es.close();
      esRef.current = null;
      setView("results");
    });

    es.addEventListener("error", (ev) => {
      console.error("[rPPG] SSE error event", ev);
      es.close();
      esRef.current = null;
      setView("failure");
    });

    es.onerror = () => {
      console.error("[rPPG] SSE onerror");
      es.close();
      esRef.current = null;
      setView("failure");
    };
  }, []);

  /* --------- Real streaming (upload path) --------- */
  const startStreaming = useCallback(async (uploadFile) => {
    setView("processing");
    setChunks(buildInitialChunks().map((c, i) => i === 0 ? { ...c, status: "active" } : c));
    setCurrentIdx(0);
    setFinal(null);

    // 1. Upload the file
    let job_id;
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      ({ job_id } = await res.json());
    } catch (err) {
      console.error("[rPPG] upload error", err);
      setView("failure");
      return;
    }

    // 2. Open SSE stream
    openStream(job_id);
  }, [openStream]);

  /* --------- Derived: running average (SQI-weighted) --------- */
  const runningAvg = useMemo(() => {
    const valid = chunks.filter(c => c.status === "done");
    if (!valid.length) return null;
    const w = valid.reduce((s, c) => s + c.quality, 0);
    return Math.round(valid.reduce((s, c) => s + c.bpm * c.quality, 0) / w);
  }, [chunks]);

  const overallBpm  = final?.overall_bpm ?? runningAvg ?? 76;
  const pulsePeriod = overallBpm > 0 ? (60 / overallBpm).toFixed(2) : 0.8;

  // Perf: prefer server-side numbers, fall back to local estimate
  const perf = useMemo(() => {
    if (final?.perf) {
      return {
        total:  final.perf.total_seconds.toFixed(1),
        avg:    final.perf.avg_chunk_seconds.toFixed(1),
        frames: final.perf.frames_processed,
      };
    }
    const valid = chunks.filter(c => c.status === "done").length;
    return {
      total:  (valid * 1.5).toFixed(1),
      avg:    "1.5",
      frames: valid * 150,
    };
  }, [chunks, final]);

  /* --------- Handlers --------- */
  const onPickFile = (f) => setFile(f); // f is a real File object

  const onPickSample = useCallback(async () => {
    setView("processing");
    setChunks(buildInitialChunks().map((c, i) => i === 0 ? { ...c, status: "active" } : c));
    setCurrentIdx(0);
    setFinal(null);
    setFile({ name: "sample-face-60s.mp4", size: 1.1 * 1024 * 1024 });

    let job_id;
    try {
      const res = await fetch("/api/analyze/sample", { method: "POST" });
      if (!res.ok) throw new Error(`Sample request failed: ${res.status}`);
      ({ job_id } = await res.json());
    } catch (err) {
      console.error("[rPPG] sample error", err);
      setView("failure");
      return;
    }

    // Reuse the same SSE machinery as the upload path
    openStream(job_id);
  }, [openStream]);

  const onStart = () => {
    if (!file) return;
    startStreaming(file);
  };

  const onRecordComplete = (blob) => {
    const recordedFile = new File([blob], "recording.webm", { type: "video/webm" });
    setFile(recordedFile);
    startStreaming(recordedFile);
  };

  const onCancel = () => {
    esRef.current?.close();
    esRef.current = null;
    setView("upload");
    setFile(null);
    setChunks(buildInitialChunks());
    setCurrentIdx(0);
    setFinal(null);
  };

  const onReset = () => {
    esRef.current?.close();
    esRef.current = null;
    setView("upload");
    setFile(null);
    setChunks(buildInitialChunks());
    setCurrentIdx(0);
    setFinal(null);
  };

  return (
    <div className="page">
      <Header/>

      {view === "upload" && (
        <UploadZone
          file={file}
          mode={uploadMode}
          setMode={setUploadMode}
          onPickFile={onPickFile}
          onPickSample={onPickSample}
          onStart={onStart}
          onRecordComplete={onRecordComplete}
        />
      )}
      {view === "processing" && (
        <ProcessingView
          file={file}
          chunks={chunks}
          runningAvg={runningAvg}
          currentIdx={currentIdx}
          total={12}
          onCancel={onCancel}
          pulsePeriod={pulsePeriod}
          bpm={runningAvg ?? 76}
          roiLost={false}
          showWaveform={false}
        />
      )}
      {view === "results" && (
        <ResultsView
          chunks={chunks}
          perf={perf}
          overallBpm={overallBpm}
          ci={final?.ci}
          biomarkers={{
            rr:    final?.respiratory_rate ?? null,
            rmssd: final?.hrv?.rmssd ?? null,
            sdnn:  final?.hrv?.sdnn ?? null,
            lfhf:  final?.hrv?.lf_hf ?? null,
          }}
          pulsePeriod={pulsePeriod}
          file={file}
          onReset={onReset}
          bvp={final?.bvp ?? []}
        />
      )}
      {view === "failure" && (
        <WholeFailure
          onRetry={onReset}
          onSample={onPickSample}
        />
      )}
    </div>
  );
}

/* ============================================================
   Mount
   ============================================================ */
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App/>);
