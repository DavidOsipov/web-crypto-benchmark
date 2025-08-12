      
# Methodology for Data Collection and Analysis for the Web Crypto API Benchmarking Project

* **Document Version:** 4.6
* **Date:** 2025-08-13
* **Audience:** Technical specialists, experts in statistics, web performance, and browser technologies.

## 1. Introduction and Research Goals

This document outlines the methodology used for the collection and analysis of performance data for cryptographic hashing in modern web browsers. Following a strategic review, the project's primary goal has been reformulated to prioritize **measurement precision, scientific rigor, and real-world robustness** over simple representativeness.

**The primary research goal** is to perform a high-precision, comparative analysis of Web Crypto engine throughput, answering the following questions:

1.  **Browser Engine Performance Comparison:** Under optimized, low-noise conditions, what are the precise performance differences in `SubtleCrypto.digest()` implementations between major browser engines?
2.  **Hardware & Environment Impact:** How do hardware characteristics (CPU architecture, core count) and environmental context (mobile vs. desktop) correlate with hashing throughput?
3.  **Algorithm Scalability:** What is the precise performance scaling curve for different SHA algorithms as data size increases on various platforms?

The methodology is designed with three key principles in mind: **maximum precision**, **statistical robustness**, and **bias minimization**.

---

## 2. Client-Side Measurement Methodology: A Robust, Precision-First Approach

To achieve our research goals, the client-side architecture has been redesigned to aggressively eliminate sources of measurement noise while also adapting to the constraints of different execution environments.

### 2.1. Execution Environment: Cross-Origin Isolation (Mandatory)

**Decision:** The benchmark is exclusively deployed on a page served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. The benchmark **MUST** refuse to run if `window.crossOriginIsolated` is `false`.

**Rationale:**
*   **High-Resolution Timers:** This is the most critical benefit. Cross-origin isolation (COI) unlocks high-precision timers (`performance.now()`), reducing measurement quantization error by orders of magnitude.
*   **SharedArrayBuffer Access:** COI is a prerequisite for using `SharedArrayBuffer`, which is essential for our low-interference communication protocol.
*   **Process Stability:** COI provides stronger process isolation, reducing interference from other browser tabs and system processes.

### 2.2. Communication Protocol: SharedArrayBuffer with Atomic Coordination

**Decision:** All high-frequency data, specifically the per-batch timing samples, are communicated from the Web Worker to the main thread via a `SharedArrayBuffer` (SAB).

**Rationale:**
*   **Elimination of Serialization Overhead:** The standard `postMessage` API involves cloning data, which introduces CPU load and scheduling jitter. SAB allows for zero-copy data transfer, making communication virtually silent and non-interfering.
*   **Robust Atomic Coordination:** A "reserve-and-commit" protocol using atomic counters (`WR_HEAD`, `COMMITTED`) ensures the main thread never reads stale or incomplete data. The overflow check has been hardened to use the buffer's explicit capacity, preventing off-by-one errors.

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

**Decision:** Before any measurement begins for each test cell, an adaptive warmup phase is performed to ensure the Just-In-Time (JIT) compiler has fully optimized the relevant code paths. A separate, brief warmup is also performed during the initial calibration phase.

#### 2.5.2. Preventing Memoization: Performant Input Pooling

**Decision:** A pool of eight buffers (`poolSize: 8`) is used cyclically to prevent JS engines from memoizing results. To avoid performance jitter during pool creation, the buffers are filled using a fast, non-cryptographic Pseudo-Random Number Generator (PRNG) that is seeded once from a secure source (`crypto.getRandomValues`).

### 2.6. Environment-Aware Configuration (Mobile vs. Desktop)

**Decision:** The benchmark now detects mobile environments and applies a separate, more conservative configuration profile to mitigate thermal throttling.

**Rationale:** Passively cooled mobile devices will overheat and slow down during long, intensive benchmarks, invalidating the results. The mobile profile uses a shorter total time budget, longer target batch times (to absorb OS jitter), and a slightly relaxed stability threshold to account for the noisier environment.

### 2.7. Data Integrity Safeguards

#### 2.7.1. Visibility State Handling

**Decision:** The benchmark now listens for the `visibilitychange` event. If the page is moved to the background, the run is immediately aborted to prevent the collection of invalid data from a throttled tab.

#### 2.7.2. Thermal Cooldowns

**Decision:** When running with the mobile profile, a 1.5-second cooldown pause is inserted between the measurement of each test cell. This allows the device's SoC a chance to cool down, preventing cumulative heat buildup and further reducing the risk of thermal throttling.

### 2.8. Ensuring Statistical Stability and Precision

Our adaptive measurement strategy is designed to achieve a high degree of statistical power for each individual test run.

#### 2.8.1. Robust Multi-Sample Calibration

**Decision:** The initial estimation of a cell's performance is now based on the **median** of three short calibration runs.

**Rationale:** The previous single-run calibration was a single point of failure. A random system event during that one run could poison the adaptive batch sizing for the entire cell. The new median-based approach robustly rejects such outliers, leading to more stable and reliable measurements.

#### 2.8.2. Multi-Phase Measurement Orchestration

The worker executes a three-phase process for each full benchmark run:
1.  **Phase 1: Calibration:** A quick run of each test cell is performed to get an initial performance estimate.
2.  **Phase 2: Budget Allocation:** A generous total time budget is intelligently allocated across all test cells based on their calibration time.
3.  **Phase 3: Measurement & Remediation:** The main measurement loop is executed. If a cell is unstable, it is automatically re-run up to `MAX_REMEDIATION_ATTEMPTS` times.

### 2.9. Collected Metrics (Per Test Cell)

For each {algorithm, size} pair, a rich object is collected. The **primary metric of interest is `momMs`**.
*   **`momMs` (Median-of-Means):** Our primary robust estimator of central tendency.
*   **`bootstrapCi95Ms` (Bootstrap Confidence Interval):** A non-parametric 95% confidence interval for the mean, now calculated efficiently using a performant, securely-seeded PRNG.
*   **`opsPerSec`:** Operations per second, calculated as `1000 / momMs`.
*   **`medianMs`, `iqrMs`:** The median and Interquartile Range.
*   **`coefficientOfVariation`:** A quality indicator (`stddev / mean`).
*   `isStable`, `remediationAttempts`: Flags indicating the final quality state.
*   `debugSeedFingerprint`: An optional, privacy-safe hash of the PRNG seed, included only in debug builds for run correlation.

---

## 3. Data Structure and Collection Protocol

### 3.1. Payload Structure & Privacy

**Decision:** Data is sent as a single JSON object. The payload is now **privacy-hardened by default**. High-entropy debug information (such as raw per-batch timings or the seed fingerprint) is stripped from the payload and is only included when an explicit `debugMode` flag is enabled for internal testing.

### 3.2. Data Collector Architecture

**Decision:** The legacy Google Apps Script collector has been deprecated. The new architecture uses a secure "Backend for Frontend" (BFF) built on the Cloudflare platform (Worker + D1 Database), which fully complies with the project's Security Constitution.

---

## 4. Post-Hoc Data Analysis Strategy

### 4.1. Data Pre-processing and Filtering

1.  **Filtering by Version & Quality:** Analysis will be filtered by `scriptVersion` and the `isStable` flag.
2.  **Environment Segmentation:** The new `isMobile` flag will be a primary variable for segmenting results.

### 4.2. Descriptive and Inferential Statistics

*   **Primary Measures:** The **Median-of-Means (`momMs`)** and the **Bootstrap Confidence Interval (`bootstrapCi95Ms`)** remain the primary metrics.
*   **Hypothesis Testing:** A **Linear Mixed-Effects Model** will be used to test hypotheses, with `log(opsPersec)` as the dependent variable. `isMobile` will be included as a key fixed effect.
*   **Automated Regression Testing:** A new CI workflow (`perf-smoke.yml`) automatically runs a performance smoke test on every pull request, preventing regressions in performance or stability.

    
