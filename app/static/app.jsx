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
   URL routing helpers (History API — no router library)
   ============================================================ */
function parseRoute() {
  const path = window.location.pathname;
  const m = path.match(/^\/analyze\/([^/]+)$/);
  if (m) return { page: "analyze", jobId: m[1] };
  return { page: "home" };
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
  const [failureMsg, setFailureMsg] = useState(null); // error message for failure card
  const [uploadMode, setUploadMode] = useState("sample"); // sample | upload | record
  const esRef = useRef(null);
  const activeJobRef = useRef(null); // tracks current job_id for popstate

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

  /* --------- URL routing: handle browser back/forward --------- */
  useEffect(() => {
    const onPopState = () => {
      const route = parseRoute();
      if (route.page === "home") {
        // Back to home — cancel any active stream
        esRef.current?.close();
        esRef.current = null;
        activeJobRef.current = null;
        setView("upload");
        setFile(null);
        setChunks(buildInitialChunks());
        setCurrentIdx(0);
        setFinal(null);
        setFailureMsg(null);
        setUploadMode("sample");
      } else if (route.page === "analyze" && route.jobId !== activeJobRef.current) {
        // Navigated to a different job — attempt to open its stream.
        // If the server doesn't have it (restarted), the SSE 404 will trigger failure.
        esRef.current?.close();
        activeJobRef.current = route.jobId;
        setView("processing");
        setChunks(buildInitialChunks().map((c, i) => i === 0 ? { ...c, status: "active" } : c));
        setCurrentIdx(0);
        setFinal(null);
        setFailureMsg(null);
        openStream(route.jobId);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []); // openStream is stable (useCallback with no deps that change)

  // On initial load, if the URL is /analyze/<id>, try to reconnect.
  useEffect(() => {
    const route = parseRoute();
    if (route.page === "analyze") {
      activeJobRef.current = route.jobId;
      setView("processing");
      setChunks(buildInitialChunks().map((c, i) => i === 0 ? { ...c, status: "active" } : c));
      setCurrentIdx(0);
      openStream(route.jobId);
    }
  }, []); // run once on mount

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
      // Named 'error' SSE event from the server — genuine pipeline failure
      es.close();
      esRef.current = null;
      setView("failure");
    });

    es.onerror = () => {
      // Transport-level error (e.g., 404 for unknown job_id after server restart)
      es.close();
      esRef.current = null;
      if (activeJobRef.current) {
        // Was a reconnect attempt from URL — fall back cleanly to upload view
        history.replaceState(null, "", "/");
        activeJobRef.current = null;
        setView("upload");
        setUploadMode("sample");
      } else {
        setView("failure");
      }
    };
  }, []);

  /* --------- Real streaming (upload path) --------- */
  const startStreaming = useCallback(async (uploadFile) => {
    setView("processing");
    setChunks(buildInitialChunks().map((c, i) => i === 0 ? { ...c, status: "active" } : c));
    setCurrentIdx(0);
    setFinal(null);
    setFailureMsg(null);

    // 1. Upload the file
    let job_id;
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      if (!res.ok) {
        let msg = `Upload failed (${res.status})`;
        try {
          const body = await res.json();
          if (body.detail) msg = body.detail;
        } catch (_) {}
        setFailureMsg(msg);
        setView("failure");
        return;
      }
      ({ job_id } = await res.json());
    } catch (err) {
      setView("failure");
      return;
    }

    // 2. Push URL so browser back works
    history.pushState(null, "", `/analyze/${job_id}`);
    activeJobRef.current = job_id;

    // 3. Open SSE stream
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
    setFailureMsg(null);
    setFile({ name: "sample-face-60s.mp4", size: 1.1 * 1024 * 1024 });

    let job_id;
    try {
      const res = await fetch("/api/analyze/sample", { method: "POST" });
      if (!res.ok) throw new Error(`Sample request failed: ${res.status}`);
      ({ job_id } = await res.json());
    } catch (err) {
      setView("failure");
      return;
    }

    // Push URL so browser back works
    history.pushState(null, "", `/analyze/${job_id}`);
    activeJobRef.current = job_id;

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

  const resetToUpload = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    activeJobRef.current = null;
    history.replaceState(null, "", "/");
    setView("upload");
    setFile(null);
    setChunks(buildInitialChunks());
    setCurrentIdx(0);
    setFinal(null);
    setFailureMsg(null);
    setUploadMode("sample");
  }, []);

  const onCancel = resetToUpload;
  const onReset  = resetToUpload;

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
          message={failureMsg}
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
