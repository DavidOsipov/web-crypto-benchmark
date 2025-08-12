# Web Crypto API Precision Benchmark

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Security Policy](https://img.shields.io/badge/Security-Policy-informational)](./SECURITY.md)
[![CI Perf Smoke Test](https://github.com/your-username/your-repo/actions/workflows/perf-smoke.yml/badge.svg)](https://github.com/your-username/your-repo/actions/workflows/perf-smoke.yml)

This repository contains the complete source code for a high-precision, browser-based cryptographic hashing benchmark. This code powers an interactive widget designed to perform rigorous, lab-grade performance analysis and allow users to anonymously contribute to a foundational dataset.

It is engineered with three core principles: **maximum precision**, **statistical robustness**, and **security by design**.

---

### **Participate in the Live Research**

You can run the benchmark and contribute your results on the official project page:

*   **In English:** [**Help Me Benchmark the Web Crypto API**](https://david-osipov.vision/en/blog/help-me-benchmark-web-crypto/)
*   **In Russian:** [**Помогите мне протестировать Web Crypto API**](https://david-osipov.vision/ru/blog/help-me-benchmark-web-crypto/)

---

## Key Features

This benchmark has been specifically engineered to deliver the highest possible measurement precision, targeting browser engineers, hardware vendors, and performance researchers.

*   **Environment-Aware Measurement Engine:** The benchmark intelligently adapts to its environment to ensure the collection of high-quality, relevant data.
    *   **Mobile vs. Desktop Profiles:** The engine automatically detects mobile environments and applies a more conservative testing profile. This includes a shorter total runtime and longer batch times to prevent thermal throttling on passively cooled devices, ensuring results reflect sustained performance, not just initial burst speed.
    *   **Thermal Cooldowns:** On mobile, the benchmark inserts deliberate pauses between heavy tasks to allow the device's SoC to cool, further mitigating the risk of performance degradation from overheating.

*   **Precision-First Measurement Methodology:** Designed to produce exceptionally low-noise and repeatable results by systematically eliminating common sources of measurement error.
    *   **Cross-Origin Isolated Environment:** The benchmark **requires** a cross-origin isolated environment (`COOP`/`COEP` headers). This is a deliberate design choice to unlock high-resolution timers and stronger process isolation, which are critical for accurate sub-millisecond measurements.
    *   **`SharedArrayBuffer` for Zero-Copy Communication:** All high-frequency timing data is passed from the worker to the main thread via a `SharedArrayBuffer` using a robust, two-counter atomic protocol. This eliminates the CPU overhead and scheduling jitter associated with `postMessage` cloning.
    *   **Dedicated Web Worker Isolation:** All cryptographic tests run in a dedicated Web Worker to prevent UI rendering and other main-thread tasks from contaminating the measurements.

*   **Advanced Statistical Engine:**
    *   **Robust Estimators:** The primary reported metric is the **Median-of-Means (MoM)**, which is highly resistant to outliers. A non-parametric **Bootstrap Confidence Interval** is also calculated using a performant, securely-seeded PRNG to provide a robust measure of uncertainty.
    *   **Robust Calibration:** The initial performance estimate for each test is based on the **median** of multiple short runs, preventing a single system hiccup from skewing the entire measurement.
    *   **Automated Remediation:** If a measurement is unstable (high variance), the engine automatically re-runs the test to improve data quality without user intervention.

*   **Secure and Private by Design:**
    *   **Data Integrity Safeguards:** The benchmark automatically aborts if the browser tab is moved to the background, preventing the collection of invalid data from a throttled process.
    *   **Privacy-Hardened Telemetry:** The script collects non-identifiable metrics. High-entropy debug data is stripped from telemetry payloads by default and is only included in opt-in debug builds. Raw PRNG seeds are never transmitted.
    *   **Hardened Security:** The project adheres to a strict [Security Constitution](./docs/security-constitution.md), including a strong Content Security Policy (CSP), the use of Trusted Types, and a hardened, secure-by-default design.

## Project Structure

*   `/src`: Contains the core JavaScript source code.
    *   `crypto-benchmark.js`: The main script that orchestrates the benchmark, manages the UI, and handles environment detection.
    *   `crypto-benchmark.worker.js`: The Web Worker that implements the core measurement engine.
    *   `crypto-benchmark.stats.js`: A utility module for advanced statistical calculations.
    *   `/util/prng.js`: A shared module for the fast, securely-seeded Pseudo-Random Number Generator.
*   `/docs`: Contains all project documentation.
    *   `METHODOLOGY_EN.md` & `METHODOLOGY_RU.md`: A detailed, scientific explanation of the measurement and analysis techniques.
    *   `Security Constitution.md`: The governing document for all security and engineering decisions.
*   `/tests`: Would contain the Vitest unit, integration, and end-to-end tests.
*   `/scripts`: Would contain helper scripts, including the `perf-smoke.mjs` harness for CI.

## Usage

To use this benchmark component in your own cross-origin isolated environment, you would typically embed it within a page structure similar to the one used on the project website. The script will automatically find and mount itself to a `<section>` element containing the necessary UI components.

## Contributing

Contributions are welcome! Please read the [Contributing Guidelines](./CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests. All PRs are automatically checked against our performance smoke test to prevent regressions.

## Author and License

- **Author:** This project was architected and directed by **David Osipov**, an AI-Driven B2B Lead Product Manager. You can learn more about my work and philosophy at [david-osipov.vision](https://david-osipov.vision).
- **ISNI:** 0000 0005 1802 960X ([International Standard Name Identifier](https://isni.org/isni/000000051802960X))
- **ORCID:** [0009-0005-2713-9242](https://orcid.org/0009-0005-2713-9242)
- **VIAF:** [139173726847611590332](https://viaf.org/viaf/139173726847611590332/)
- **Wikidata:** [Q130604188](https://www.wikidata.org/wiki/Q130604188)
- **Contact:** <personal@david-osipov.vision>
- **License:** MIT License. The license is specified using the [SPDX-License-Identifier](https://spdx.org/licenses/) standard, which is a machine-readable way to declare licenses.
