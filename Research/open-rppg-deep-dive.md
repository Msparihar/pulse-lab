# Open-rPPG: Integration Deep-Dive Report

## Executive Summary

The open-rppg library is a JAX-based remote photoplethysmography (rPPG) toolkit supporting 17 pre-trained models for heart rate and HRV estimation from facial video. It uses stateful inference with buffering and multi-threaded processing. For FastAPI integration, the key constraints are: (1) state must be preserved across frames, (2) minimum 2 seconds of signal for HR/HRV calculation, (3) JAX CPU works on Windows but XLA compilation adds 5-10s overhead on first load.

---

## 1. Model Loading and Architecture

### Available Models

The library ships with **17 pre-trained models** in two training variants (`.rlap` and `.pure`):

- **ME-chunk** / **ME-flow**: State-space (Mamba2) models
- **PhysMamba**: Dual-branch Mamba architecture
- **RhythmMamba**: Frequency-domain Mamba
- **PhysFormer**: Temporal Difference Transformer
- **TSCAN**: Temporal Shift Convolutional Attention
- **EfficientPhys**: Self-attention variant of TSCAN
- **PhysNet**: 3D Conv Encoder-Decoder
- **FacePhys**: Optimized state-space model (default)

**Source**: `rppg/main.py:395-398`, `rppg/__init__.py`

### Weight Loading Mechanism

**Bundled in the wheel**: Weights are distributed with the package using `pkg_resources.resource_filename()`.

**Example (FacePhys)**:
```
weights_path = pkg_resources.resource_filename(
    'rppg', 'weights/FacePhys.rlap.weights.h5'
)
```
Source: `rppg/models.py:1793`

**First load behavior**:
1. Model weights loaded via Keras `.load_weights()` into JAX arrays
2. JAX JIT compilation triggered on first inference call
3. Models use `@lru_cache(maxsize=1)` to cache loaded models per process
4. No internet required (all weights bundled)

**Size**: FacePhys.rlap = 3.0 MB; PhysFormer variants = 15 MB. See `rppg/weights/` directory (79 MB total).

**First inference time**: ~5-10 seconds on Windows (JAX XLA compilation overhead). Subsequent calls are ~10-50ms depending on model complexity.

**Source**: `rppg/models.py:1791-1802`

---

## 2. Frame Requirements and FPS Handling

### Expected FPS

**Default**: 30 FPS (hardcoded in model metadata)

Source: `rppg/models.py:418` (FacePhys), line 445 (ME-rlap): `'fps':30.`

### FPS Mismatch Handling

When processing video files, the library detects actual FPS and issues warnings:

```python
fps = np.mean(1/np.diff(tsarr))  # actual FPS from frame timestamps
if not (self.fps*0.95 < fps < self.fps*1.05):  # ±5% tolerance
    logger.warning('Frame rate mismatch, performing nearest neighbor sampling.')
    goodvid = False
if fps_std > 0.05*fps:  # standard deviation check
    logger.warning('Frame rate is unstable...')
```

**What happens with 24 FPS or 60 FPS?**
- Signal is resampled to the model's expected FPS (30) using nearest-neighbor interpolation
- Library logs a warning but continues processing
- HR/HRV calculations use the original (reported) FPS, so results should be valid

Source: `rppg/main.py:801-816`

### Input Resolution

**Models expect pre-cropped faces** at fixed resolution. By default: **36×36 pixels** (single-frame models) or **160 frames @ 36×36** (chunk models).

**Resolution handling**:
- For `process_video_tensor()`: User provides full frames; library runs built-in face detection (BlazeFace ONNX)
- For `process_faces_tensor()`: User provides pre-cropped faces, which are resized to model's input resolution via `cv2.resize(..., interpolation=cv2.INTER_AREA)`

Source: `rppg/main.py:619-624`

---

## 3. Tensor Input Contract

### Exact Requirements

**Signature**: `model.process_video_tensor(tensor, fps=30.)` or `model.process_faces_tensor(tensor, fps=30.)`

**Input shape & dtype**:
- Shape: `(T, H, W, 3)` — T = number of frames, H = height, W = width, 3 = RGB channels
- Dtype: `uint8` with values in range [0, 255]
- Validation: Raises `TypeError` if dtype ≠ uint8 or shape != 4D or channels ≠ 3

Source: `rppg/main.py:754-758` (process_video_tensor), `766-769` (process_faces_tensor)

**Minimum frames**: 
- For HR estimation: **≥ 60 frames at 30 FPS** (2 seconds) to pass the buffer check
- For HRV: **≥ 60 frames** (same 2-second minimum for SQI threshold)
- The library filters out signals < 2 seconds:
  ```python
  if 'bvp' not in signals or ts[-1]-ts[0]<2:
      return [], []  # returns empty
  ```

Source: `rppg/main.py:593-597`

**150 frames (5s @ 30 FPS)**: Works perfectly. The library has a streaming architecture that processes frames in chunks (1 frame for single-frame models, 160 frames for chunk models) as they arrive.

---

## 4. Signal Quality Index (SQI) Computation

### Algorithm

SQI measures the autocorrelation of the BVP signal in the physiological frequency band:

```python
def SQI(signal, sr=30, min_freq=0.5, max_freq=3.0, window_size=10):
    # Normalize signal
    signal = (signal - mean) / (std + 1e-8)
    
    # Compute autocorrelation
    autocorr = np.correlate(signal, signal, mode='full')
    autocorr = autocorr / autocorr[0]  # normalize by peak
    
    # Extract autocorr in HR band (0.5-3.0 Hz = 30-180 BPM)
    min_lag = sr / max_freq = 30/3 = 10 samples
    max_lag = sr / min_freq = 30/0.5 = 60 samples
    peak_value = max(autocorr[10:60])
    
    # SQI is peak autocorr value, clipped to [0, 1]
    return clip(peak_value, 0, 1)
```

**Window size**: Defaults to 10 seconds; signal is divided into overlapping windows, SQI values averaged.

**Interpretation**:
- **SQI > 0.5**: Signal quality is acceptable, HRV computed
- **SQI ≤ 0.5**: Signal rejected, HRV not computed (empty dict returned)
- **SQI ~ 0.0**: Noise or no periodic component
- **SQI ~ 1.0**: Clean, strong periodic signal

Source: `rppg/main.py:47-72`

---

## 5. Error Modes and Exception Handling

### No Face Detected

**Returns**: Empty zeros array; processing continues with zero signal

```python
if not len(r):  # face detector returns []
    face_img = lambda: np.zeros(self.input[1:], dtype='uint8')
    self.statistic['null'] += 1
```

**Result**: `process_video_tensor()` returns `None` if no signal buffer is populated

Source: `rppg/main.py:628-630`

### Video Too Short

**Minimum for HR/HRV**: 2 seconds of detected signal

```python
if 'bvp' not in signals or ts[-1]-ts[0] < 2:
    return [], []  # hr() then returns None
```

**No explicit exception**, returns `None` from `.hr()` call.

Source: `rppg/main.py:593-597`

### Inference Failure

**Exception handling**: Generic `try/except` with logging:

```python
try:
    sqi = SQI(...)
    hrv = get_prv(...)  # may fail if heartpy has issues
    hr = get_hr(...)
except:
    hr, sqi, hrv = None, None, {}
```

**Returns**: `{'hr': None, 'SQI': None, 'hrv': {}, 'latency': ...}`

Source: `rppg/main.py:608-616`

### JAX/Keras Exceptions

Not explicitly caught. If JAX fails to JIT or Keras fails to build:
- Exceptions propagate to caller
- Logged via `sys.excepthook` in background inference thread
- May result in silent failure if not monitored

Source: `rppg/main.py:518-520`

---

## 6. JAX/CPU on Windows

### Dependency Chain

```
keras >= 3.5.0
  → jax >= 0.4.26  (Keras backend)
onnxruntime >= 1.8  (face detector)
```

Source: `requirements.txt`

### Windows Compatibility

**CPU-only mode**: JAX defaults to CPU backend on Windows without CUDA. **No special configuration needed.**

Environment variables used (non-blocking):
```python
os.environ["KERAS_BACKEND"] = "jax"
os.environ["XLA_PYTHON_CLIENT_PREALLOCATE"] = "false"  # avoid OOM on first load
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'  # suppress TF logs (legacy)
os.environ['ORT_LOGGING_LEVEL'] = '3'     # suppress ONNX logs
```

Source: `rppg/__init__.py`, `rppg/models.py:2-4`

### Known Gotchas

1. **First load JAX compilation (5-10s)**: XLA compiler creates cache; subsequent loads fast
2. **No platform-specific imports**: Library works identically on Windows/Linux CPU
3. **Memory**: Each model instance is ~100-500 MB in JAX memory; no pooling mechanism built-in

---

## 7. Threading and Concurrency

### Architecture

The `Model` class **is NOT inherently thread-safe** but uses internal threading for real-time processing:

```python
# Inside __enter__():
self.face_detection_pool = ThreadPoolExecutor(max_workers=...)
self.face_resampling_pool = ThreadPoolExecutor(max_workers=...)
self.ift = threading.Thread(target=inference, daemon=True)  # inference thread
```

**Synchronization**: Semaphores, locks, and queues:
- `face_buff`: Thread-safe queue (lock-protected)
- `signal_buff`: Dictionary populated by inference thread
- `sp` (semaphore): Signals availability of buffered frames
- `preview_lock`: Guards access to current frame for preview

Source: `rppg/main.py:459-485`

### Recommendation for FastAPI

**Instantiate one Model per worker process** (not per request):

✅ **Correct**:
```python
# At startup
model = rppg.Model()

@app.post("/process")
async def process_video(file):
    # Use model directly
    result = model.process_video_tensor(...)
```

❌ **Incorrect** (creates overhead):
```python
@app.post("/process")
async def process_video(file):
    model = rppg.Model()  # 5-10s overhead per request!
    result = model.process_video_tensor(...)
```

**Multiple concurrent requests**: Safe to process different tensors concurrently *if* using different Model instances. However, JAX JIT compilation is global; contention may slow down first calls.

### Context Manager Usage

The `with model:` context manager is **required**:
- Initializes state and thread pools
- Starts inference thread
- Returns before exiting scope

If calling `process_video()` or `process_video_tensor()`, it handles the context internally.

Source: `rppg/main.py:459-523`

---

## 8. HRV Output Metrics

### Full Output Structure

```python
result = model.hr()
# {
#   'hr': float,           # Heart rate (BPM)
#   'SQI': float,          # Signal quality [0-1]
#   'latency': float,      # Time in seconds since last frame processed
#   'hrv': {
#       'bpm': float,
#       'ibi': float,
#       'sdnn': float,
#       'rmssd': float,
#       'pnn50': float,
#       'LF': float,
#       'HF': float,
#       'LF/HF': float,
#       'VLF': float,
#       'TP': float,
#       'breathingrate': float
#   }
# }
```

### Metric Definitions

**HRV metrics** (from `get_prv()` function):

1. **bpm** (BPM from peak detection): Heart rate computed via peak detection on inter-beat intervals. Time-domain metric.

2. **ibi** (Inter-Beat Interval, milliseconds): Mean RR interval (time between consecutive heartbeats) in ms.

3. **sdnn** (Standard Deviation of NN intervals): Variability of RR intervals. Higher = more heart rate variability. Computed by heartpy library.

4. **rmssd** (Root Mean Square of Successive Differences): Square root of mean squared successive RR differences. Indicates parasympathetic tone.

5. **pnn50** (Proportion of NN50): % of successive RR intervals differing by >50ms. High value = high vagal tone.

6. **LF (Low Frequency, 0.04-0.15 Hz)**: Power in low-frequency band. Associated with sympathetic + parasympathetic activity.

7. **HF (High Frequency, 0.15-0.4 Hz)**: Power in high-frequency band. Associated with parasympathetic (vagal) activity.

8. **LF/HF (Ratio)**: Sympathetic-to-parasympathetic balance. Normal range: 1-3.

9. **VLF (Very Low Frequency, 0.0033-0.04 Hz)**: Power in very-low-frequency band. Associated with thermoregulation and hormonal activity.

10. **TP (Total Power)**: Sum of VLF + LF + HF. Total variability.

11. **breathingrate** (Hz or breaths/min): Estimated respiration rate extracted from RR interval oscillation.

**Source**: `rppg/main.py:78-96` (get_prv function, which wraps heartpy)

### When HRV is Computed

HRV is only computed if **SQI > 0.5**:

```python
if return_hrv and sqi > 0.5:
    hrv = get_prv(bvp, ts, self.fps)
else:
    hrv = {}
```

If SQI ≤ 0.5, the returned `hrv` dict is empty.

Source: `rppg/main.py:610-612`

---

## Decisions for Our Integration

### Recommended Architecture

1. **Singleton Model Instance**: Instantiate one `rppg.Model('FacePhys.rlap')` at FastAPI startup. Reuse across requests.
   - Avoids 5-10s XLA compilation overhead per request
   - Suffices for streaming (state is reset per `with model:` context)

2. **Preprocessing**: Expect client to provide either:
   - Full video frames (use `process_video_tensor()`)
   - Pre-cropped faces (use `process_faces_tensor()`)
   - Both are equivalent; face detection adds ~50ms per frame on CPU

3. **Minimum Input**: 
   - Accept ≥ 60 frames (2 seconds @ 30 FPS)
   - Reject with 400 error if shorter
   - Warn if FPS ≠ 30 (client should resample)

4. **Result Handling**:
   - Return `{'error': 'Insufficient signal'}` if `model.hr()` returns `None`
   - Return empty `hrv: {}` if `SQI ≤ 0.5` (library does this automatically)
   - Always include `SQI` in response for downstream validation

5. **Concurrency**:
   - Safe to process multiple tensors sequentially or in separate Model instances
   - Do NOT create a Model per request (overhead)
   - Do NOT attempt to call `process_video_tensor()` concurrently on same Model (not thread-safe across requests)

6. **Error Recovery**:
   - Wrap `model.hr()` in try-except; exceptions are rare but possible from JAX/Keras
   - Log full exception; return 500 error to client
   - Do NOT restart Model instance (state is reset per request anyway)

7. **Model Selection**:
   - Default to `'FacePhys.rlap'` (optimized, smallest)
   - For accuracy: `'PhysFormer.rlap'` or `'RhythmMamba.rlap'` (both 12-15 MB, high quality)
   - For speed: `'TSCAN.rlap'` or `'EfficientPhys.rlap'` (1-4 MB, minimal accuracy trade-off)

### Example FastAPI Endpoint

```python
from fastapi import FastAPI
import rppg
import numpy as np

app = FastAPI()
model = rppg.Model('FacePhys.rlap')

@app.post("/estimate_hr")
async def estimate_hr(video: VideoTensor):
    # video.frames: numpy array (T, H, W, 3) uint8
    # video.fps: float (default 30.0)
    
    if len(video.frames) < 60:
        return {"error": "Video too short (minimum 2 seconds @ 30 FPS)"}
    
    try:
        result = model.process_video_tensor(video.frames, fps=video.fps)
        if result is None:
            return {"error": "No face detected or inference failed"}
        return result  # {'hr': ..., 'SQI': ..., 'hrv': {...}, 'latency': ...}
    except Exception as e:
        return {"error": str(e)}, 500
```

### Performance Expectations

| Operation | Time (Windows CPU) | Notes |
|-----------|-------------------|-------|
| Model load + first inference | 5-10s | JAX XLA compilation |
| Subsequent inference (60 frames) | 50-150ms | Depends on model size |
| HR/HRV computation | 10-50ms | Post-processing |
| Face detection (per frame) | 5-10ms | BlazeFace ONNX |
| **Total per 150-frame request** | **150-500ms** | Without face detection |

### Gotchas to Avoid

1. **Don't create a new Model per request** — reuse singleton instance
2. **Don't pass 24fps or 60fps directly** — either resample client-side to 30fps or pass correct fps parameter
3. **Don't expect HRV if SQI < 0.5** — check the library's behavior
4. **Don't call model.process_video_tensor() concurrently** — use sequential processing or multiple Model instances
5. **Don't set `return_hrv=False` in hr()** — not exposed via public API; HRV is automatic if SQI > 0.5

---

## References

- **Model Architecture**: `rppg/models.py` (1784 lines, JAX+Keras)
- **Main API**: `rppg/main.py` (843 lines, threading + signal processing)
- **SQI Algorithm**: `rppg/main.py:47-72`
- **HRV Computation**: `rppg/main.py:78-96`
- **Face Detection**: `rppg/main.py:171-393` (BlazeFace ONNX wrapper)
- **Threading Model**: `rppg/main.py:459-523` (context manager + inference thread)
