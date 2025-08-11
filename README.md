# Web Crypto API Precision Benchmark

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Security Policy](https://img.shields.io/badge/Security-Policy-informational)](./SECURITY.md)

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

*   **Precision-First Measurement Methodology:** Designed to produce exceptionally low-noise and repeatable results by systematically eliminating common sources of measurement error.
    *   **Cross-Origin Isolated Environment:** The benchmark **requires** a cross-origin isolated environment (`COOP`/`COEP` headers). This is a deliberate design choice to unlock high-resolution timers and stronger process isolation, which are critical for accurate sub-millisecond measurements.
    *   **`SharedArrayBuffer` for Zero-Copy Communication:** All high-frequency timing data is passed from the worker to the main thread via a `SharedArrayBuffer` using a robust, two-counter atomic protocol. This eliminates the CPU overhead and scheduling jitter associated with `postMessage` cloning, ensuring the measurement process itself does not interfere with the results.
    *   **Dedicated Web Worker Isolation:** All cryptographic tests run in a dedicated Web Worker to prevent UI rendering and other main-thread tasks from contaminating the measurements.

*   **Advanced Statistical Engine:**
    *   **Robust Estimators:** The primary reported metric is the **Median-of-Means (MoM)**, which is highly resistant to outliers caused by system noise. A non-parametric **Bootstrap Confidence Interval** is also calculated to provide a robust measure of uncertainty.
    *   **Adaptive Batch Sizing:** The engine intelligently adjusts the number of iterations per batch to target a substantial duration (e.g., ~300ms), maximizing the signal-to-noise ratio for each sample.
    *   **Automated Remediation:** If a measurement is unstable (high variance), the engine automatically re-runs the test to improve data quality without user intervention.

*   **Secure and Private by Design:**
    *   **Privacy-Focused Data Collection:** The script collects non-identifiable metrics. A random `anonId` is generated to group sessions from the same browser, and a `runId` identifies each specific test run. No IP addresses are stored by the collection backend.
    *   **Hardened Security:** The project adheres to a strict [Security Constitution](./docs/security-constitution.md), including a strong Content Security Policy (CSP), the use of Trusted Types, and a hardened, secure-by-default design.

## Project Structure

*   `/src`: Contains the core JavaScript source code.
    *   `crypto-benchmark.js`: The main script that orchestrates the benchmark, manages the UI, and provisions the `SharedArrayBuffer`.
    *   `crypto-benchmark.worker.js`: The Web Worker that implements the core measurement engine and writes results to the SAB.
    *   `crypto-benchmark.stats.js`: A utility module for advanced statistical calculations.
*   `/docs`: Contains all project documentation.
    *   `methodology.md`: A detailed, scientific explanation of the measurement and analysis techniques.
    *   `security-constitution.md`: The governing document for all security and engineering decisions.

## Usage

To use this benchmark component in your own cross-origin isolated environment, you would typically embed it within a page structure similar to the one used on the project website. The script will automatically find and mount itself to a `<section>` element containing the necessary UI components.

## Contributing

Contributions are welcome! Please read the [Contributing Guidelines](./CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## Author and License

- **Author:** This project was architected and directed by **David Osipov**, an AI-Driven B2B Lead Product Manager. You can learn more about my work and philosophy at [david-osipov.vision](https://david-osipov.vision).
- **ISNI:** 0000 0005 1802 960X ([International Standard Name Identifier](https://isni.org/isni/000000051802960X))
- **ORCID:** [0009-0005-2713-9242](https://orcid.org/0009-0005-2713-9242)
- **VIAF:** [139173726847611590332](https://viaf.org/viaf/139173726847611590332/)
- **Wikidata:** [Q130604188](https://www.wikidata.org/wiki/Q130604188)
- **Contact:** <personal@david-osipov.vision>
- **License:** MIT License. The license is specified using the [SPDX-License-Identifier](https://spdx.org/licenses/) standard, which is a machine-readable way to declare licenses.
