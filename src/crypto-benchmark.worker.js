// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2025 David Osipov <personal@david-osipov.vision>
// Author Website: https://david-osipov.vision
// Author ISNI: 0000 0005 1802 960X
// Author ISNI URL: https://isni.org/isni/000000051802960X
// Author ORCID: 0009-0005-2713-9242
// Author VIAF: 139173726847611590332
// Author Wikidata: Q130604188
// Version: 4.6.3
// Web Worker for crypto benchmark: performs WebCrypto digest measurements off the main thread.
import { mean, median, stddev, coefficientOfVariation, quartiles, medianOfMeans, bootstrapCI } from "./crypto-benchmark.stats.js";
import { createCryptoSeededPRNG, seedFingerprintHex } from "@lib/prng.js";

// Create a single worker-scoped PRNG to ensure consistent seeding across all uses in this run
const _workerPrngObj = createCryptoSeededPRNG();
const workerPrng = _workerPrngObj.prng;
const workerSeedBuffer = _workerPrngObj.seedBuffer;

// SharedArrayBuffer header layout indices (Int32)
const H_VERSION = 0;
const H_FLAGS = 1;
const H_WR_HEAD = 2;     // reserved write head (monotonic counter)
const H_COMMITTED = 3;   // published samples (monotonic)
const H_DROPPED = 4;     // overflow counter
const H_RUN_ID_LOW = 5;  // reserved for future use
const H_RUN_ID_HIGH = 6; // reserved for future use
const H_PAD = 7;         // padding to ensure 8*4B = 32B offset for Float64 alignment
const DONE_FLAG = 1 << 0;

// Debug helper: guarded postMessage for logs
function wlog(type, payload) {
  try { self.postMessage({ type, ...payload }); } catch {}
}

// Signal readiness so the main thread can detect startup issues
try { wlog("ready", {}); } catch {}

// Simple sleep utility for cooldowns
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRandomDataPool(size, poolSize) {
  const prng = workerPrng;
  const pool = [];
  for (let i = 0; i < poolSize; i++) {
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let j = 0;
    // Fill in 4-byte chunks when possible
    for (; j + 4 <= buf.length; j += 4) {
      const v32 = ((prng() * 4294967296) >>> 0);
      dv.setUint32(j, v32, true);
    }
    // Remaining tail bytes
    for (; j < buf.length; j++) {
      dv.setUint8(j, ((prng() * 256) | 0) & 0xFF);
    }
    pool.push(buf);
  }
  return pool;
}

async function digestOnce(algo, data) {
  const subtle = self.crypto?.subtle;
  const start = self.performance.now();
  await subtle.digest(algo, data);
  const end = self.performance.now();
  return end - start;
}

// Estimate the smallest non-zero difference between consecutive performance.now() calls.
function estimateTimerGranularity() {
  let last = self.performance.now();
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 1000; i++) {
    const t = self.performance.now();
    const d = t - last;
    if (d > 0 && d < minDiff) minDiff = d;
    last = t;
  }
  if (!isFinite(minDiff)) return 0; // fallback when clock resolution is effectively continuous in loop
  return minDiff;
}

/**
 * Measure average SAB publish overhead (ms) using the same reserve/write/publish path.
 * Runs until a minimum elapsed time for stable averaging.
 */
function measureSABOverhead(ctrl, data, capMask) {
  try {
    const targetMinMs = 50;
    const sample = 0.123456789;

    const publish = () => {
      const head = Atomics.add(ctrl, H_WR_HEAD, 1);
      const slot = head & capMask;
      const isValid = Number.isInteger(slot) && slot >= 0;
      if (isValid) {
        // eslint-disable-next-line security/detect-object-injection -- bounded slot via mask
        data[slot] = sample;
      }
      // publish contiguously for single-writer
      const committed = Atomics.load(ctrl, H_COMMITTED);
      if (committed === head) {
        Atomics.store(ctrl, H_COMMITTED, head + 1);
      }
    };

    // JIT warmup
    for (let i = 0; i < 2000; i++) publish();
    Atomics.store(ctrl, H_WR_HEAD, 0);
    Atomics.store(ctrl, H_COMMITTED, 0);
    Atomics.store(ctrl, H_DROPPED, 0);

    let iters = 0;
    const t0 = self.performance.now();
    do {
      // modest unroll for timer stability
      publish(); publish(); publish(); publish(); publish();
      publish(); publish(); publish(); publish(); publish();
      iters += 10;
    } while ((self.performance.now() - t0) < targetMinMs);
    const t1 = self.performance.now();
  return (t1 - t0) / Math.max(1, iters);
  } catch {
    return 0;
  }
}

async function measureCell({ algo, size, warmupIters, measureIters, targetMinMs, poolSize, TARGET_BATCH_MS, CV_STOP_THRESHOLD, MIN_RECORDED_BATCHES, PER_BATCH_SAMPLE_LIMIT, PER_CELL_MAX_BATCHES = 100, sabCtrl, sabData, sabMask, sabCapacity, streamSamples, concurrency = 1 }) {
  const subtle = self.crypto?.subtle;
  if (!subtle?.digest) throw new Error("WebCrypto subtle.digest unavailable");

  // Warmup with rotating inputs
  const pool = createRandomDataPool(size, Math.max(1, poolSize | 0));
  // Adaptive warmup: stop early if moving average stabilizes <1% over last 3 checks
  {
    const maxWarm = Math.max(0, warmupIters | 0);
    let lastAvg = Number.POSITIVE_INFINITY;
    const window = [];
    const windowSize = 5;
    for (let i = 0; i < maxWarm; i++) {
      const t0 = self.performance.now();
  await subtle.digest(algo, pool.at(i % pool.length));
      const t1 = self.performance.now();
      window.push(t1 - t0);
      if (window.length > windowSize) window.shift();
      const avg = window.reduce((a, b) => a + b, 0) / window.length;
      // Every few samples check stabilization
      if (i > windowSize && lastAvg !== Number.POSITIVE_INFINITY) {
        const delta = Math.abs(avg - lastAvg) / Math.max(1e-9, lastAvg);
        if (delta < 0.01) break; // stabilized
      }
      lastAvg = avg;
    }
  }

  // Adaptive batch sizing: target a minimum duration per batch for stability
  const targetBatchMs = Math.max(10, TARGET_BATCH_MS || 125); // >=10ms
  const MAX_TOTAL_ITERS = 100000; // safety cap for very fast ops
  // Align batches cap with caller-provided limit while keeping an absolute ceiling
  const maxBatchesReq = Number(PER_CELL_MAX_BATCHES);
  const MAX_BATCHES = Math.min(Math.max(1, Number.isFinite(maxBatchesReq) ? Math.trunc(maxBatchesReq) : 100), 1000);

  const minMs = Math.max(0, targetMinMs || 0);
  const baseIters = Math.max(1, measureIters | 0);

  let perBatchTimesMs = [];
  // CRITICAL BUG FIX: track iterations used per batch precisely
  let perBatchIters = [];
  let totalIters = 0;
  let batches = 0;
  let totalElapsedMs = 0;

  // Helper to run a batch with N iterations and return total ms
  async function runBatch(N) {
    const start = self.performance.now();
    if (concurrency <= 1) {
      for (let i = 0; i < N; i++) {
        await subtle.digest(algo, pool.at((totalIters + i) % pool.length));
      }
    } else {
      let i = 0;
      while (i < N) {
        const k = Math.min(concurrency, N - i);
        const promises = [];
        for (let j = 0; j < k; j++) {
          promises.push(subtle.digest(algo, pool.at((totalIters + i + j) % pool.length)));
        }
        await Promise.all(promises);
        i += k;
      }
    }
    const end = self.performance.now();
    return end - start;
  }

  // --- Robust, Multi-Sample Calibration ---
  const NUM_CALIB_RUNS = 3; // Use a constant for clarity
  const calibSamplesMs = [];
  for (let i = 0; i < NUM_CALIB_RUNS; i++) {
      const t = await runBatch(baseIters);
      calibSamplesMs.push(t / baseIters); // Store per-iteration time
  }

  // Use the median of the calibration samples to resist outliers.
  const approxPerIter = median(calibSamplesMs);

  // Estimate iterations needed to hit target batch time, clamp to a sensible range.
  let adaptiveIters = Math.max(1, Math.round((Math.max(10, TARGET_BATCH_MS || 125)) / Math.max(1e-6, approxPerIter)));
  adaptiveIters = Math.min(adaptiveIters, Math.ceil(MAX_TOTAL_ITERS / 10)); // Safety bound

  // NOTE: These calibration runs are intentionally NOT added to the final results.

  // Continue with adaptive batches using the computed adaptiveIters

  // Continue running batches until cumulative time exceeds minMs or caps hit, but ensure a minimum recorded batches
  const minBatches = Math.max(0, MIN_RECORDED_BATCHES | 0);
  while ((totalElapsedMs < minMs || batches < minBatches) && totalIters < MAX_TOTAL_ITERS && batches < MAX_BATCHES) {
    const usedIters = adaptiveIters; // snapshot before any adjustment
    const t = await runBatch(usedIters);
    totalIters += usedIters;
    batches += 1;
    totalElapsedMs += t;
    perBatchTimesMs.push(t);
    perBatchIters.push(usedIters);

    // Stream per-iteration sample into SAB using reserve -> write -> publish protocol
    if (streamSamples && sabCtrl && sabData && sabMask) {
      const sample = t / usedIters;
      // reserve a slot
      const head = Atomics.add(sabCtrl, H_WR_HEAD, 1);
      const committed = Atomics.load(sabCtrl, H_COMMITTED);
      // Capacity in slots; prefer explicit sabCapacity, else derive from mask (power-of-two)
      const capacity = Number.isInteger(sabCapacity) && sabCapacity > 0 ? sabCapacity : ((sabMask | 0) + 1);
      // Use the NEW head (head + 1) for occupancy; drop if writing would exceed capacity
      const occupancy = (head + 1) - committed;
      if (occupancy > capacity) {
        Atomics.add(sabCtrl, H_DROPPED, 1);
      } else {
        const slot = head & sabMask;
        // Validate computed slot index to satisfy security lint and prevent OOB writes
        const isValidSlot = Number.isInteger(slot) && slot >= 0;
        if (isValidSlot) {
          // eslint-disable-next-line security/detect-object-injection -- slot is validated and bounded by power-of-two mask
          sabData[slot] = sample;
        }
        // publish contiguously for single-writer
        const cur = Atomics.load(sabCtrl, H_COMMITTED);
        if (cur === head) {
          Atomics.store(sabCtrl, H_COMMITTED, head + 1);
        }
      }
    }

    // Optional: adjust adaptiveIters if we are far from target per-batch time
    // Use a gentle adjustment to avoid oscillation
    const factor = targetBatchMs / Math.max(1e-6, t);
    // Only adjust if off by >20%
    if (factor > 1.2 || factor < 0.8) {
      adaptiveIters = Math.max(1, Math.round(adaptiveIters * factor));
      adaptiveIters = Math.min(adaptiveIters, Math.ceil(MAX_TOTAL_ITERS / 10));
    }

    // Early stop: if we've passed half the target and CoV is below strict threshold, break
  if (totalElapsedMs >= (minMs * 0.5)) {
  const perIterSoFar = perBatchTimesMs.map((tt, idx) => tt / ((perBatchIters.at(idx)) || baseIters));
      const muSoFar = mean(perIterSoFar);
      const covSoFar = coefficientOfVariation(perIterSoFar, muSoFar);
      if (typeof CV_STOP_THRESHOLD === "number" && covSoFar <= CV_STOP_THRESHOLD) break;
    }
  }

  // Convert per-batch total ms to per-iteration ms samples for statistics? No: we
  // base our stats on per-iteration times to derive ops/sec; however, batch totals
  // are more stable, so compute per-iter by dividing each batch by its iteration count.
  // The first calibration batch used baseIters; subsequent batches used adaptiveIters.
  const perIterSamples = perBatchTimesMs.map((t, idx) => t / ((perBatchIters.at(idx)) || baseIters));

  const mu = mean(perIterSamples);
  const med = median(perIterSamples);
  const sd = stddev(perIterSamples, mu);
  const cov = coefficientOfVariation(perIterSamples, mu);
  const [q25, q75] = quartiles(perIterSamples);
  const iqr = q75 - q25;

  const mom = medianOfMeans(perIterSamples, 5);
  const [ciLo, ciHi] = bootstrapCI(perIterSamples, 2000, workerPrng);

  // Downsample per-batch times for diagnostics payload if needed
  let perBatchOut = perBatchTimesMs.slice();
  const limit = Math.max(0, PER_BATCH_SAMPLE_LIMIT | 0);
  if (limit > 0 && perBatchOut.length > limit) {
    const step = perBatchOut.length / limit;
    const sampled = [];
    for (let i = 0; i < limit; i++) {
  sampled.push(perBatchOut.at(Math.floor(i * step)));
    }
    perBatchOut = sampled;
  }

  // Note: primary streaming was done inside the batch loop above.

  const opsPerSec = mom > 0 ? (1000 / mom) : 0;
  const out = {
    // Core identifiers
    algo,
    sizeBytes: size,
    // Primary robust metrics (per-op times in ms)
    momMs: mom,
    bootstrapCi95Ms: [ciLo, ciHi],
    medianMs: med,
    iqrMs: iqr,
    // Quality & debug metrics
    coefficientOfVariation: cov,
    stdMs: sd,
    // Raw counts
    iterations: totalIters,
    batches,
    // Throughput
    opsPerSec,
  };
  // Keep perBatchMs only in debug/dev builds for local inspection
  if (self && self.DEBUG && streamSamples) {
    try { out.perBatchMs = perBatchOut.slice(); } catch {}
  }
  return out;
}

self.addEventListener("message", async (ev) => {
  const { cmd, cfg } = ev.data || {};
  if (cmd !== "measure") return;
  try {
  // Wire debug flag from main thread (strictly opt-in)
  try { self.DEBUG = Boolean(cfg?.DEBUG); } catch {}
    // Enforce COI only when requested by cfg; allow degraded mode for tests
    if (cfg?.crossOriginIsolated && !self.crossOriginIsolated) {
      self.postMessage({ type: "error", error: "Cross-origin isolation required." });
      return;
    }
    wlog("log", { phase: "start", cfg: { algos: cfg?.algos?.length || 0, sizes: cfg?.sizes?.length || 0 } });
    const { algos, sizes } = cfg || {};
  const {
      warmupIters = 100,
      measureIters = 20,
      CALIBRATION_ITERS = 20,
      TOTAL_BUDGET_MS = 60000,
      TARGET_BATCH_MS = 200,
      CV_FLAG_THRESHOLD = 0.10,
      CV_STOP_THRESHOLD = 0.03,
      MAX_REMEDIATION_ATTEMPTS = 1,
  MIN_RECORDED_BATCHES = 8,
  PER_BATCH_SAMPLE_LIMIT = 40,
  poolSize = 8,
  modeRequested = "universal",
  pairedRunId = "",
  crossOriginIsolated = false,
      } = cfg || {};

    // Wire SAB if provided
  let sabCtrl = null, sabData = null, sabMask = 0;
  const sabCapRaw = Number(cfg?.sabCapacity);
  const sabCapacity = Number.isSafeInteger(sabCapRaw) && sabCapRaw > 0 ? sabCapRaw : 0;
    if (cfg?.sab instanceof SharedArrayBuffer) {
      const CTRL_INTS = 8;
      const ctrlBytes = Int32Array.BYTES_PER_ELEMENT * CTRL_INTS;
      sabCtrl = new Int32Array(cfg.sab, 0, CTRL_INTS);
      sabData = new Float64Array(cfg.sab, ctrlBytes);
      const cap = sabCapacity;
      if (cap && (cap & (cap - 1)) === 0) {
        sabMask = cap - 1;
      }
    }


  // Phase 0: Environment Probing
    const timerGranularityMs = estimateTimerGranularity();
    self.postMessage({ type: "progress", phase: 0, message: "Probing timer granularity…", timerGranularityMs });

    // One-time SAB overhead measurement and reset
    let sabOverheadMs = 0;
    if (sabCtrl && sabData && sabMask) {
      try { sabOverheadMs = measureSABOverhead(sabCtrl, sabData, sabMask); } catch {}
      try {
        Atomics.store(sabCtrl, H_WR_HEAD, 0);
        Atomics.store(sabCtrl, H_COMMITTED, 0);
        Atomics.store(sabCtrl, H_DROPPED, 0);
      } catch {}
    }

    // Optional debug-only PRNG seed fingerprint (privacy-safe, never sent by default)
    let debugSeedFingerprint = null;
    if (self.DEBUG && typeof seedFingerprintHex === "function") {
      try {
        debugSeedFingerprint = await seedFingerprintHex(workerSeedBuffer, 8);
      } catch {}
    }

    // Phase 1: Calibration
    const totalCells = (algos?.length || 0) * (sizes?.length || 0);
    let cellsCalibrated = 0;
    const calibrationData = [];

    async function calibrateCell(algo, size) {
      const subtle = self.crypto?.subtle;
      const pool = createRandomDataPool(size, Math.max(1, poolSize | 0));
      // --- START ADDITION ---
      // Brief fixed warmup to allow JIT optimization before calibration
      const WARMUP_N = 50;
      for (let i = 0; i < WARMUP_N; i++) {
        await subtle.digest(algo, pool.at(i % pool.length));
      }
      // --- END ADDITION ---
      const N = Math.max(1, CALIBRATION_ITERS | 0);
      const start = self.performance.now();
      for (let i = 0; i < N; i++) {
        await subtle.digest(algo, pool.at(i % pool.length));
      }
      const end = self.performance.now();
      const total = Math.max(0, end - start);
      const perOp = total / N;
      return perOp;
    }

    for (const algo of algos) {
      for (const size of sizes) {
        try {
          const time = await calibrateCell(algo, size);
          calibrationData.push({ algo, size, time });
          cellsCalibrated += 1;
          self.postMessage({ type: "progress", phase: 1, message: "Phase 1/3: Calibrating performance…", completed: cellsCalibrated, total: totalCells });
        } catch (cellErr) {
          calibrationData.push({ algo, size, time: Number.POSITIVE_INFINITY, error: String(cellErr?.message || cellErr) });
          cellsCalibrated += 1;
          self.postMessage({ type: "progress", phase: 1, message: "Phase 1/3: Calibrating performance…", completed: cellsCalibrated, total: totalCells });
        }
      }
    }

    // Phase 2: Budget Allocation
    const weights = calibrationData.map((c) => 1 / Math.sqrt(Math.max(1e-12, c.time)));
    const totalWeight = weights.reduce((s, w) => s + (isFinite(w) ? w : 0), 0) || 1;
    const measurementPlan = calibrationData.map((cell) => {
      const w = 1 / Math.sqrt(Math.max(1e-12, cell.time));
      const wSafe = isFinite(w) ? w : 0;
      const allocatedMs = TOTAL_BUDGET_MS * (wSafe / totalWeight);
      return { algo: cell.algo, size: cell.size, allocatedMs, calibrationTimeMs: cell.time };
    });

    // Phase 3: Measurement with Remediation
    let cellsMeasured = 0;
    for (let idx = 0; idx < measurementPlan.length; idx++) {
      const cell = measurementPlan.at(idx);
      const { algo, size, allocatedMs } = cell;
      self.postMessage({ type: "progress", phase: 2, message: `Measuring ${algo} @ ${Math.round(size / 1024)}KB…`, current: cellsMeasured + 1, total: totalCells, completed: cellsMeasured });
      let remediationAttempts = 0;
      let result;
    try {
  result = await measureCell({ algo, size, warmupIters, measureIters, targetMinMs: allocatedMs, poolSize, TARGET_BATCH_MS, CV_STOP_THRESHOLD, MIN_RECORDED_BATCHES, PER_BATCH_SAMPLE_LIMIT, PER_CELL_MAX_BATCHES: Number(cfg?.PER_CELL_MAX_BATCHES) || 100, sabCtrl, sabData, sabMask, sabCapacity, streamSamples: Boolean(cfg?.includePerBatchInPayload && sabCtrl && sabData && sabMask), concurrency: Math.max(1, Number(cfg?.concurrency) | 0) || 1 });
      } catch (err) {
        self.postMessage({ type: "result", payload: { algo, sizeBytes: size, error: String(err?.message || err), timerGranularityMs } });
        cellsMeasured += 1;
        continue;
      }

      let isStable = typeof result.coefficientOfVariation === "number" && result.coefficientOfVariation <= CV_FLAG_THRESHOLD;
      while (!isStable && remediationAttempts < Math.max(0, MAX_REMEDIATION_ATTEMPTS | 0)) {
        remediationAttempts += 1;
        self.postMessage({ type: "progress", phase: 3, message: "Re-running unstable tests for accuracy…", current: cellsMeasured + 1, total: totalCells });
        try {
          result = await measureCell({ algo, size, warmupIters, measureIters, targetMinMs: allocatedMs, poolSize, TARGET_BATCH_MS: TARGET_BATCH_MS * 1.5, CV_STOP_THRESHOLD, MIN_RECORDED_BATCHES, PER_BATCH_SAMPLE_LIMIT, PER_CELL_MAX_BATCHES: Number(cfg?.PER_CELL_MAX_BATCHES) || 100, sabCtrl, sabData, sabMask, sabCapacity, streamSamples: Boolean(cfg?.includePerBatchInPayload && sabCtrl && sabData && sabMask), concurrency: Math.max(1, Number(cfg?.concurrency) | 0) || 1 });
          isStable = typeof result.coefficientOfVariation === "number" && result.coefficientOfVariation <= CV_FLAG_THRESHOLD;
        } catch (err2) {
          self.postMessage({ type: "result", payload: { algo, sizeBytes: size, error: String(err2?.message || err2), timerGranularityMs } });
          cellsMeasured += 1;
          continue;
        }
      }

      const finalRow = {
        ...result,
        isStable,
        remediationAttempts,
      };
      self.postMessage({ type: "result", payload: finalRow });
      // --- THERMAL COOLDOWN ---
      if (cfg?.isMobile) {
        await sleep(1500);
      }
      cellsMeasured += 1;
    }
    if (sabCtrl) {
      const f = Atomics.load(sabCtrl, H_FLAGS) | DONE_FLAG;
      Atomics.store(sabCtrl, H_FLAGS, f);
    }
  self.postMessage({ type: "done", meta: { timerGranularityMs, sabOverheadMs, crossOriginIsolated: self.crossOriginIsolated === true, ...(self.DEBUG && debugSeedFingerprint ? { debugSeedFingerprint } : {}) } });
  } catch (err) {
    self.postMessage({ type: "error", error: String(err?.message || err) });
  }
});
