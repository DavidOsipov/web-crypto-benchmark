# Methodology for Data Collection and Analysis for the Web Crypto API Benchmarking Project

**Document Version:** 4.0
**Date:** 2025-08-12
**Audience:** Technical specialists, experts in statistics, web performance, and browser technologies.

## 1. Introduction and Research Goals

This document outlines the methodology used for the collection and analysis of performance data for cryptographic hashing in modern web browsers. Following a strategic review, the project's primary goal has been reformulated to prioritize **measurement precision and scientific rigor** over real-world representativeness.

**The primary research goal** is to perform a high-precision, comparative analysis of Web Crypto engine throughput, answering the following questions:

1.  **Browser Engine Performance Comparison:** Under optimized, low-noise conditions, what are the precise performance differences in `SubtleCrypto.digest()` implementations between major browser engines (V8, SpiderMonkey, JavaScriptCore)?
2.  **Hardware Architecture Impact:** How do fundamental hardware characteristics (CPU architecture, core count, device memory) correlate with hashing throughput when environmental noise is minimized?
3.  **Algorithm Scalability:** What is the precise performance scaling curve for different SHA algorithms as data size increases on various platforms?

The methodology is designed with three key principles in mind: **maximum precision**, **statistical robustness**, and **bias minimization**.

---

## 2. Client-Side Measurement Methodology: A Precision-First Approach

To achieve our research goals, the client-side architecture has been redesigned to aggressively eliminate sources of measurement noise. This is a "lab-condition" benchmark.

### 2.1. Execution Environment: Cross-Origin Isolation (Mandatory)

**Decision:** The benchmark is exclusively deployed on a page served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. The benchmark **MUST** refuse to run if `window.crossOriginIsolated` is `false`.

**Rationale:**
*   **High-Resolution Timers:** This is the most critical benefit. Cross-origin isolation (COI) unlocks high-precision timers (`performance.now()`), reducing measurement quantization error by orders of magnitude (from ~100µs to ~5µs or less). This dramatically improves the signal-to-noise ratio for sub-millisecond operations.
*   **SharedArrayBuffer Access:** COI is a prerequisite for using `SharedArrayBuffer`, which is essential for our low-interference communication protocol.
*   **Process Stability:** COI provides stronger process isolation, reducing interference from other browser tabs and system processes.

### 2.2. Communication Protocol: SharedArrayBuffer with Atomic Coordination

**Decision:** All high-frequency data, specifically the per-batch timing samples, are communicated from the Web Worker to the main thread via a `SharedArrayBuffer` (SAB).

**Rationale:**
*   **Elimination of Serialization Overhead:** The standard `postMessage` API involves cloning data, which introduces CPU load and scheduling jitter, directly contaminating the measurements. SAB allows for zero-copy data transfer, making communication virtually silent and non-interfering.
*   **Robust Atomic Coordination:** To ensure data integrity and prevent race conditions, a **two-counter atomic protocol** is used. The worker reserves a write slot using one atomic counter (`WR_HEAD`) and only makes the data visible to readers by incrementing a second counter (`COMMITTED`) *after* the write is complete. This "reserve-and-commit" pattern guarantees that the main thread will never read stale or incomplete data.

### 2.3. Execution Context: Web Worker

**Decision:** All cryptographic operations and measurements are performed exclusively inside a dedicated Web Worker (`crypto-benchmark.worker.js`).

**Rationale:**
*   **Main-Thread Decoupling:** This prevents UI rendering, event handling, and garbage collection on the main thread from interfering with timing measurements.

### 2.4. Test Parameters

**Decision:**
*   **Algorithms (`algos`):** `["SHA-256", "SHA-384", "SHA-512"]`.
*   **Data Sizes (`sizes`):** `[1 KB, 5 KB, 10 KB, 20 KB, 40 KB, 80 KB, 100 KB]`.

### 2.5. Mitigation of Measurement Biases

#### 2.5.1. JIT Compiler Warmup

**Decision:** Before any measurement begins for each test cell, an adaptive warmup phase is performed. This phase is designed to ensure the Just-In-Time (JIT) compiler has fully optimized the relevant code paths. A separate, brief warmup is also performed during the initial calibration phase.

#### 2.5.2. Preventing Memoization: Input Pooling

**Decision:** A pool of eight buffers (`poolSize: 8`) with random data is used cyclically to prevent JS engines from memoizing (caching) results, which would produce unrealistic performance metrics.

### 2.6. Ensuring Statistical Stability and Precision

Our adaptive measurement strategy is designed to achieve a high degree of statistical power for each individual test run.

#### 2.6.1. Multi-Phase Measurement Orchestration

The worker executes a three-phase process for each full benchmark run:
1.  **Phase 1: Calibration:** A quick run of each test cell is performed to get an initial performance estimate.
2.  **Phase 2: Budget Allocation:** A generous total time budget is intelligently allocated across all test cells. Slower operations are allocated more time to ensure they collect a sufficient number of samples. This is based on an inverse-square-root weighting of their calibration time.
3.  **Phase 3: Measurement & Remediation:** The main measurement loop is executed for each cell according to its allocated time budget.

#### 2.6.2. Adaptive Batch Sizing and Iteration Accounting

**Decision:** The benchmark dynamically adjusts the number of iterations per batch to target a substantial execution time (`TARGET_BATCH_MS: 300ms`).

**Rationale:**
*   **Signal-to-Noise Maximization:** Long batch durations make short, random noise events statistically insignificant.
*   **Correctness:** The number of iterations used for *each specific batch* is recorded. The final per-operation time is calculated by dividing each batch's duration by its corresponding iteration count, ensuring statistical accuracy.

#### 2.6.3. Automated Remediation

**Decision:** If a measurement for a test cell is deemed unstable (high variance), the benchmark will automatically re-run that specific test up to `MAX_REMEDIATION_ATTEMPTS` times.

**Rationale:**
*   This improves the quality of the final dataset by self-correcting for transient noise events (e.g., a sudden background OS task) without requiring user intervention.

### 2.7. Collected Metrics (Per Test Cell)

For each {algorithm, size} pair, a rich object is collected for analysis. The **primary metric of interest is `momMs`**.
*   **`momMs` (Median-of-Means):** Our primary robust estimator of central tendency. It is highly resistant to outliers from heavy-tailed system noise.
*   **`bootstrapCi95Ms` (Bootstrap Confidence Interval):** A non-parametric 95% confidence interval for the mean, calculated from 2000 resamples. This provides a robust measure of uncertainty.
*   **`opsPerSec`:** Operations per second, calculated as `1000 / momMs`.
*   **`medianMs`, `iqrMs`:** The median and Interquartile Range, for traditional robust statistical analysis.
*   **`coefficientOfVariation`:** A quality indicator (`stddev / mean`). A low value indicates a stable measurement.
*   `isStable`, `remediationAttempts`: Flags indicating the final quality state of the measurement.
*   `iterations`, `batches`: Diagnostic data about the measurement process.
*   `calibrationTimeMs`, `timerGranularityMs`: Environmental and diagnostic metadata.

---

## 3. Data Structure and Collection Protocol

### 3.1. Payload Structure

**Decision:** Data is sent as a single JSON object containing `scriptVersion`, `runId`, anonymized `env` data, and the `results` array. The `env` object explicitly includes `crossOriginIsolated: true`. The `perBatchMs` array is no longer included in the final `result` objects, as this data is now streamed via the `SharedArrayBuffer`.

### 3.2. Data Collector Architecture

**Decision:** The legacy Google Apps Script collector has been deprecated. The new architecture uses a secure, multi-layered "Backend for Frontend" (BFF) built on the Cloudflare platform. A **Cloudflare Worker** validates and processes incoming data, which is then stored in a **Cloudflare D1** SQL database. This architecture fully complies with the project's Security Constitution, notably the prohibition of client-side secrets.

---

## 4. Post-Hoc Data Analysis Strategy

The analysis strategy is designed to leverage the high-precision, low-noise data produced by the lab-condition methodology.

### 4.1. Data Pre-processing and Filtering

1.  **Filtering by Version:** Analysis will only be performed on data with the correct `scriptVersion`.
2.  **Filtering by Quality:** While the client-side remediation provides a first line of defense, server-side analysis will still use the `isStable` flag and `coefficientOfVariation` for fine-grained filtering.
3.  **Deduplication:** `runId` and `anonId` will be used to manage duplicates.

### 4.2. Descriptive and Inferential Statistics

*   **Primary Measures:** The **Median-of-Means (`momMs`)** and the **Bootstrap Confidence Interval (`bootstrapCi95Ms`)** will be the primary metrics for reporting central tendency and dispersion, chosen for their robustness and precision.
*   **Hypothesis Testing:** A **Linear Mixed-Effects Model** will be the primary tool for hypothesis testing. This allows us to account for the nested structure of the data (multiple measurements per user) and control for confounding variables.
    *   **Dependent Variable:** `log(opsPersec)` will be used as the dependent variable to stabilize variance and model multiplicative effects.
    *   **Fixed Effects:** `algorithm`, `size`, `browserEngine`, `os`, `hardwareConcurrency`, etc.
    *   **Random Effect:** `anonId` will be included as a random intercept to account for baseline performance differences between individual participants.
