# Chunked Remote-PPG Processing: Best Practices for 5-Second Window Aggregation

## 1. Window Length: Is 5 Seconds Long Enough?

Yes, 5 seconds is sufficient for stable BPM estimation, though with a small accuracy penalty. Research on the UBFC-rPPG dataset shows that increasing window size beyond 5 seconds yields minimal accuracy gains; performance at 5 seconds is already very close to the best achievable with longer windows. The practical recommendation is that 3-second windows approach the accuracy floor, meaning at 5 seconds you've recouped most gains. Deep learning methods like TS-CAN and PhysNet achieve mean absolute error (MAE) of 0.98–1.30 BPM on UBFC-rPPG with full 60-second videos trained at 30 fps, but production systems routinely use shorter windows. For a 60-second video split into 12 disjoint 5-second chunks, expect an accuracy penalty of 2–4 BPM compared to full-video estimation, primarily due to reduced spectral resolution in the FFT.

**Recommendation:** 5 seconds is acceptable; you trade ~2–3 BPM mean error for timely per-chunk feedback.

**Sources:**
- [rPPG-Toolbox: Deep Remote PPG Toolbox (NeurIPS 2023)](https://arxiv.org/pdf/2210.00716)
- [UBFC-rPPG Dataset Benchmark](https://sites.google.com/view/ybenezeth/ubfcrppg)

---

## 2. Sliding vs. Disjoint Chunks: Latency vs. Accuracy Tradeoff

**Disjoint (non-overlapping) chunks** are better for this use case. Sliding windows (e.g., 5-second windows every 1 second) have been used in real-time systems to provide updates every 1 second, but they incur higher computational cost and no meaningful accuracy improvement for your 12-chunk pipeline. The latency advantage of disjoint chunks is clear: processing 12 separate 5-second windows in parallel or sequentially completes in ~5 seconds at modest computational budgets, whereas a 1-second sliding window system requires processing 55–60 overlapping windows for the full 60 seconds.

Papers using sliding windows typically apply an 8-second window with 1-second step size for continuous HR monitoring, which is overkill for your use case (you already emit 12 chunks at regular 5-second intervals). Disjoint chunks simplify UI presentation and match the requirement to show "BPM every 5 seconds."

**Recommendation:** Use 12 disjoint 5-second chunks. Avoid sliding windows.

**Sources:**
- [Real-time remote PPG via sliding windows](https://link.springer.com/article/10.1007/s11042-023-14399-w)
- [CVPR 2023 Workshop: Robust Remote PPG](https://openaccess.thecvf.com/content/CVPR2023W/CVPM/papers/Ho_Deep_Learning-Based_Image_Enhancement_for_Robust_Remote_Photoplethysmography_in_Various_CVPRW_2023_paper.pdf)

---

## 3. FPS Handling: Resampling Input Video

Most rPPG models are trained at 30 fps (standard for webcams and older smartphones). If your input is 24 fps (cinema/GoPro) or 60 fps (modern phones), **resample to 30 fps before processing**. Resampling down from 60 fps to 30 fps is straightforward (drop alternating frames or use frame averaging); upsampling from 24 fps introduces interpolation artifacts that degrade signal fidelity.

The spectral resolution of the PPG signal in frequency space is inversely proportional to window length. A 5-second window at 30 fps yields 150 frames and a frequency resolution of 0.2 Hz (~12 BPM bins). At 60 fps, the same 5-second window has 300 frames, improving frequency resolution to 0.1 Hz but requiring models trained on that frame density. At 24 fps, 5 seconds yields 120 frames with 0.2 Hz resolution. Resampling to the training standard (30 fps) ensures consistent spectral properties and avoids model overfitting to frame artifacts.

**Recommendation:** Resample all inputs to 30 fps before chunking. Use frame dropping (60 fps → 30 fps) or temporal averaging (24 fps → 30 fps via cubic interpolation).

---

## 4. Aggregating Per-Chunk BPM into a Final Overall Estimate

Use a **SQI-weighted median**, discarding chunks with SQI < 0.293 (Normalized SQI threshold from recent rPPG research). Here's the logic:

1. Compute per-chunk BPM and per-chunk SQI (Signal Quality Index).
2. Filter: keep only chunks with SQI ≥ 0.293.
3. If < 3 chunks remain: report as "insufficient signal quality" (median of too few points is unreliable).
4. Otherwise: compute **SQI-weighted median** of the remaining BPMs.

The weighted median is more robust than arithmetic mean to outliers (a single motion-artifact chunk at 160 BPM won't drag up the average as much), and it doesn't require all chunks to be present. Papers on multi-scale rPPG aggregation use similar reliability-aware weighting. If you want simpler logic, plain median of filtered chunks (equal weight) is defensible and easier to explain to graders.

Alternative (simpler): plain median of chunks with SQI ≥ 0.293.

**Recommendation:** Weighted median of SQI-filtered chunks. If < 3 chunks pass SQI > 0.293, flag as low confidence.

**Sources:**
- [Optimal Signal Quality Index for Remote PPG](https://www.nature.com/articles/s44328-024-00002-1)
- [Reliability-Aware Weighted Multi-Scale Spatio-Temporal Maps for Heart Rate Monitoring](https://arxiv.org/abs/2603.26836)

---

## 5. SQI Threshold: When Is a Chunk "Failed"?

Use **SQI < 0.293** as the failure threshold. This Normalized Signal Quality Index (NSQI) threshold was validated on remote PPG to differentiate high-quality cardiac signals from poor or noisy ones. Chunks below this threshold typically have:
- Excessive motion artifacts
- Lighting drops or flashes
- Detector over/underexposure
- Partial face occlusion

In the UI, display chunks with SQI ≥ 0.293 normally and grey out (or mark as "⚠️ Low Signal") those below the threshold. This gives the user visibility into why a particular 5-second window didn't contribute to the final BPM.

**Recommendation:** NSQI threshold = 0.293. Grey out / warn on chunks below this in the UI.

**Sources:**
- [Optimal Signal Quality Index for Remote PPG (Nature npj Biosensing)](https://www.nature.com/articles/s44328-024-00002-1)

---

## 6. Real-Time Deployment: Known Failure Modes and Mitigations

### Failure Mode 1: Low / Changing Lighting
**Problem:** Fluorescent flicker, shadows, backlighting cause signal loss.
**Mitigation:** Add face detection confidence check and warn if lighting variance exceeds threshold; suggest user face a stable light source.

### Failure Mode 2: Motion Artifacts
**Problem:** Head movement, facial expressions contaminate PPG signal.
**Mitigation:** Use face tracking (MediaPipe) to detect large head rotations; skip or low-weight frames with high optical flow. Many models now include motion-robust preprocessing.

### Failure Mode 3: Skin Tone Bias
**Problem:** Dark skin tones (Fitzpatrick V–VI) see MAE degrade from 6 BPM to 9.5 BPM in deep learning models (chrominance methods much worse: 5.2 BPM → 14.1 BPM). Very dark or very light skin can saturate RGB sensors.
**Mitigation:** Log skin tone diversity in your dataset during development. Test explicitly on darker skin tones. Use adaptive color space (e.g., CIELab) or skin tone–aware preprocessing if time permits.

### Failure Mode 4: Occlusion (Glasses, Masks, Hair)
**Problem:** Forehead or cheeks obscured → no usable PPG signal from that region.
**Mitigation:** Allow multi-region ROI (forehead + cheeks + chin). Fail gracefully if < 60% of face is visible. Flag in UI if multiple regions are low-signal.

---

## Recommendations for This Take-Home

1. **Chunk strategy:** 12 disjoint 5-second chunks. No sliding windows.
2. **FPS resampling:** Resample all input to 30 fps (OpenCV `cv2.resize` with frame drop or interpolation).
3. **Per-chunk SQI:** Compute using open-rppg's built-in SQI metric (or implement normalized correlation with synthetic PPG template).
4. **Chunk filtering:** Discard chunks with NSQI < 0.293.
5. **Final aggregation:** SQI-weighted median of remaining chunks. If < 3 chunks pass, report low confidence.
6. **UI feedback:** Show per-chunk BPM + SQI bar (green ≥ 0.293, grey < 0.293). Display final BPM prominently with ± confidence interval.
7. **Robustness:** Add face detection confidence check pre-processing. Log frames where face is not detected or too small (< 100×100px).
8. **Test on diverse data:** Even if the dataset has limited skin tone diversity, explicitly evaluate on darker skin tones and note any performance drop—graders expect awareness of this bias.

---

## References

- [rPPG-Toolbox: Deep Remote PPG Toolbox (arXiv:2210.00716)](https://arxiv.org/pdf/2210.00716)
- [UBFC-rPPG Dataset Benchmark](https://sites.google.com/view/ybenezeth/ubfcrppg)
- [Optimal Signal Quality Index for Remote PPG (Nature npj Biosensing, 2024)](https://www.nature.com/articles/s44328-024-00002-1)
- [Reliability-Aware Weighted Multi-Scale Maps for HR (arXiv:2603.26836)](https://arxiv.org/abs/2603.26836)
- [Evaluation of Biases in Remote PPG (npj Digital Medicine, 2021)](https://www.nature.com/articles/s41746-021-00462-z)
- [PhysFlow: Skin Tone Transfer for Remote HR (BMVC 2024)](https://bmva-archive.org.uk/bmvc/2024/papers/Paper_136/paper.pdf)
- [Demographic Bias in Remote PPG Datasets (npj Digital Medicine, 2025)](https://www.nature.com/articles/s41746-025-01973-9)
- [Video-Based Heart Rate Measurement Review (renchengsong.github.io)](https://renchengsong.github.io/papers/rPPG_review.pdf)
- [Real-time Realizable Mobile Imaging PPG (Scientific Reports, 2022)](https://www.nature.com/articles/s41598-022-11265-x)
