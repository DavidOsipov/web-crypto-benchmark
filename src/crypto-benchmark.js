// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2025 David Osipov <personal@david-osipov.vision>
// Author Website: https://david-osipov.vision
// Author ISNI: 0000 0005 1802 960X
// Author ISNI URL: https://isni.org/isni/000000051802960X
// Author ORCID: 0009-0005-2713-9242
// Author VIAF: 139173726847611590332
// Author Wikidata: Q130604188
// Version: 4.6.3
// Secure browser hash benchmark widget script (ESM). No inline HTML, no innerHTML.
import { generateSecureUUID, secureDevLog } from "@utils/security-kit.js";
import { appPolicy } from "@lib/trusted-types.js";
import workerURL from "./crypto-benchmark.worker.js?worker&url";

// Track mounted instances without mutating DOM nodes
const MOUNTED = new WeakMap();
// Use dedicated worker for hashing to keep UI responsive and improve timing fidelity
// Vite's `?worker&url` ensures a same-origin HTTP(S) asset URL at build time (never data:/blob:).
// Worker() is not a Trusted Types sink; always return a same-origin string URL from bundler.
const getTrustedWorkerURL = () => {
  try { secureDevLog("info", "crypto-benchmark", "Worker() TT non-sink; using bundler URL string", {}); } catch {}
  return workerURL;
};

const TEXT = {
  en: {
    notSupported: "Web Crypto API is unavailable in this browser.",
    running: "Running benchmark…",
    aborted: "Benchmark aborted.",
    done: "Benchmark complete. Review results below and submit.",
  errorLabel: "Error",
    unstableDetected: "Analysis complete. We detected some measurement instability. For the most accurate results, we recommend closing demanding apps and tasks and running the test again.",
    submitting: "Submitting anonymously…",
    submitted: "Thank you! Results submitted.",
    submitDisabled: "Submission disabled (collector not configured).",
  },
  ru: {
    notSupported: "В этом браузере недоступен Web Crypto API.",
    running: "Запуск бенчмарка…",
    aborted: "Бенчмарк прерван.",
    done: "Бенчмарк завершен. Проверьте результаты ниже.",
  errorLabel: "Ошибка",
    unstableDetected: "Анализ завершен. Обнаружена нестабильность измерений. Для наибольшей точности рекомендуем закрыть требовательные программы и задачи, и запустить тест ещё раз.",
    submitting: "Отправка анонимных данных…",
    submitted: "Спасибо! Результаты отправлены.",
    submitDisabled: "Отправка отключена (коллектор не настроен).",
  },
};
function isMobile() {
  try {
  if (navigator.userAgentData?.mobile) return true;
  } catch {}
  try {
  return /Mobi|Android|iPhone|iPad|iPod|Kindle|Silk|Opera Mini/i.test(navigator.userAgent);
  } catch { return false; }
}

const BASE_CONFIG = Object.freeze({
  algos: ["SHA-256", "SHA-384", "SHA-512"],
  sizes: [1024, 5 * 1024, 10 * 1024, 20 * 1024, 40 * 1024, 80 * 1024, 100 * 1024],
  poolSize: 8,

  // --- Tuned Accuracy-First Parameters ---
  TOTAL_BUDGET_MS: 90000,          // 90-second total runtime budget.
  CALIBRATION_ITERS: 500,           // Iterations for the initial speed calibration.
  warmupIters: 200,                // Max iterations for adaptive JIT warmup.
  measureIters: 100,                // Iterations for the very first micro-batch in a cell.
  TARGET_BATCH_MS: 300,            // Aim for each measurement batch to take ~300ms.
  MIN_RECORDED_BATCHES: 8,         // Ensure at least this many batches for robust stats.
  CV_FLAG_THRESHOLD: 0.10,         // CoV above this triggers remediation/UI flag.
  CV_STOP_THRESHOLD: 0.03,         // Optional: Stop early if extremely stable.
  MAX_REMEDIATION_ATTEMPTS: 3,     // Auto-retry unstable cells.
  PER_BATCH_SAMPLE_LIMIT: 40,      // Max number of raw per-batch samples to send in payload.
  progressIntervalMs: 250, // throttle UI updates
  // SAB sizing: conservative cap of 128 batches per cell
  PER_CELL_MAX_BATCHES: 128,
});

const MOBILE_OVERRIDES = Object.freeze({
  TOTAL_BUDGET_MS: 30000,
  TARGET_BATCH_MS: 700,
  CV_FLAG_THRESHOLD: 0.15,
});

const CONFIG = Object.freeze(isMobile() ? { ...BASE_CONFIG, ...MOBILE_OVERRIDES } : BASE_CONFIG);

// Version emitted with submissions for downstream analysis
const SCRIPT_VERSION = "4.6.3";

async function createRunId() {
  try {
    return await generateSecureUUID();
  } catch (e) {
    try { secureDevLog("warn", "crypto-benchmark", "generateSecureUUID failed for runId", { e: String(e) }); } catch {}
    return `run-${Date.now()}`;
  }
}

function $(root, sel) {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}

function setDisabled(el, disabled) {
  const flag = Boolean(disabled);
  // Reflect both attribute and property to avoid desync across browsers/tests
  el.toggleAttribute("disabled", flag);
  try { el.disabled = flag; } catch {}
}

function setStatus(statusEl, msg) {
  statusEl.textContent = msg;
}

function updateBar(barEl, pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  barEl.style.width = `${clamped}%`;
}

function bytesString(n) {
  return `${(n / 1024).toFixed(0)} KB`;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  // Use Array.prototype.at() to avoid bracket indexing that triggers security lint
  return a.length % 2 ? a.at(mid) : ((a.at(mid - 1) ?? 0) + (a.at(mid) ?? 0)) / 2;
}

function stddev(arr, m) {
  const mu = m ?? mean(arr);
  const variance = mean(arr.map((x) => (x - mu) ** 2));
  return Math.sqrt(variance);
}

function ci95(arr) {
  // Normal approximation: 1.96 * (s / sqrt(n))
  const mu = mean(arr);
  const sd = stddev(arr, mu);
  const n = arr.length || 1;
  const half = 1.96 * (sd / Math.sqrt(n));
  return [mu - half, mu + half];
}

async function getEnv(lang) {
  const ua = navigator.userAgent;
  const languages = navigator.languages || [navigator.language].filter(Boolean);
  const env = {
    anonId: await generateSecureUUID().catch(() => ""),
    origin: location.origin,
    userAgent: ua,
    // navigator.platform is deprecated; prefer UA-CH when available, else derive from userAgent
    platform: (navigator.userAgentData && typeof navigator.userAgentData.platform === 'string')
      ? navigator.userAgentData.platform
      : (ua.includes('Win') ? 'Windows' : ua.includes('Mac') ? 'macOS' : ua.includes('Linux') ? 'Linux' : 'Unknown'),
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    languages,
  userAgentData: null,
  battery: null,
    lang,
  };
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const data = await navigator.userAgentData.getHighEntropyValues([
        "platform",
        "platformVersion",
        "architecture",
        "model",
        "bitness",
        "uaFullVersion",
        "mobile",
      ]);
      env.userAgentData = data;
    }
  } catch {}
  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      env.battery = { charging: b.charging, level: b.level };
    }
  } catch {}
  return env;
}

function buildRow({ algo, sizeBytes, momMs, bootstrapCi95Ms, medianMs, iqrMs, isStable, remediationAttempts, error, meanMs, ci95Ms }, i18nOpt) {
  const tr = document.createElement("tr");
  tr.className = "border-b border-gray-200 last:border-b-0";
  
  const c1 = document.createElement("td");
  c1.className = "text-left py-2 px-3";
  c1.textContent = algo;
  
  const c2 = document.createElement("td");
  c2.className = "text-right py-2 px-3";
  c2.textContent = bytesString(sizeBytes);
  if (error) {
    const cErr = document.createElement("td");
    cErr.className = "text-left py-2 px-3 text-[var(--color-danger,red)]";
  cErr.colSpan = 6; // span across remaining columns (total 8 cols; 2 used above)
    // Localized error label (fallback to English)
    const lbl = (i18nOpt && typeof i18nOpt.errorLabel === "string") ? i18nOpt.errorLabel : TEXT.en.errorLabel;
    cErr.textContent = `${lbl}: ${String(error)}`;
    tr.append(c1, c2, cErr);
    return tr;
  }

  // Backward compatibility with old schema used in tests: fallback to meanMs/ci95Ms
  const primaryMs = Number.isFinite(momMs) ? momMs : (Number.isFinite(meanMs) ? meanMs : 0);
  const ci = Array.isArray(bootstrapCi95Ms) && bootstrapCi95Ms.length === 2
    ? bootstrapCi95Ms
    : (Array.isArray(ci95Ms) && ci95Ms.length === 2 ? ci95Ms : [0, 0]);
  const medianVal = Number.isFinite(medianMs) ? medianMs : primaryMs;
  const iqrVal = Number.isFinite(iqrMs) ? iqrMs : 0;

  const c3 = document.createElement("td");
  c3.className = "text-right py-2 px-3";
  c3.textContent = primaryMs.toFixed(3);

  const c4 = document.createElement("td");
  c4.className = "text-right py-2 px-3";
  c4.textContent = `${(ci[0] ?? 0).toFixed(3)} – ${(ci[1] ?? 0).toFixed(3)}`;

  const c5 = document.createElement("td");
  c5.className = "text-right py-2 px-3";
  c5.textContent = medianVal.toFixed(3);

  const c6 = document.createElement("td");
  c6.className = "text-right py-2 px-3";
  c6.textContent = iqrVal.toFixed(3);

  const c7 = document.createElement("td");
  c7.className = "text-right py-2 px-3";
  c7.textContent = isStable ? "yes" : "no";

  const c8 = document.createElement("td");
  c8.className = "text-right py-2 px-3";
  c8.textContent = String(remediationAttempts ?? 0);

  tr.append(c1, c2, c3, c4, c5, c6, c7, c8);
  return tr;
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toCSV(results) {
  const header = [
    "algo",
    "sizeBytes",
    "iterations",
    "batches",
    "momMs",
    "opsPerSec",
    "bootstrapCi95Low",
    "bootstrapCi95High",
    "medianMs",
    "iqrMs",
    "stdMs",
    "coefficientOfVariation",
    "isStable",
    "remediationAttempts",
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = results
    .filter((r) => !r.error)
    .map((r) => [
      esc(r.algo),
      esc(r.sizeBytes),
      esc(r.iterations),
      esc(r.batches ?? ""),
      esc(((r.momMs ?? r.meanMs) ?? 0).toFixed(6)),
      esc((r.opsPerSec ?? (r.momMs ? (1000 / r.momMs) : 0)).toFixed(3)),
      esc((Array.isArray(r.bootstrapCi95Ms) ? r.bootstrapCi95Ms[0] : (Array.isArray(r.ci95Ms) ? r.ci95Ms[0] : 0)).toFixed(6)),
      esc((Array.isArray(r.bootstrapCi95Ms) ? r.bootstrapCi95Ms[1] : (Array.isArray(r.ci95Ms) ? r.ci95Ms[1] : 0)).toFixed(6)),
      esc(((r.medianMs ?? r.meanMs) ?? 0).toFixed(6)),
      esc((r.iqrMs ?? 0).toFixed(6)),
      esc((r.stdMs ?? 0).toFixed(6)),
      esc((r.coefficientOfVariation ?? 0).toFixed(6)),
      esc(r.isStable ? "1" : "0"),
      esc(String(r.remediationAttempts ?? 0)),
    ]);
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

// Analyze run quality: use worker's final isStable flags across cells
function analyzeRunQuality(results) {
  try {
    if (!Array.isArray(results) || results.length === 0) return false;
    let anyUnstable = false;
    for (const r of results) {
      if (r && !r.error && r.isStable === false) { anyUnstable = true; break; }
    }
    return !anyUnstable;
  } catch {
    // Fail safe: consider unstable if analysis fails
    return false;
  }
}

// measurement moved to Web Worker

export function mountCryptoBenchmark(section, { scriptEl, lang: langInput, collectorUrl } = {}) {
  const existing = MOUNTED.get(section);
  if (existing) return existing;

  const current = scriptEl || document.currentScript;
  const DEBUG = Boolean(import.meta?.env?.DEV) || (current?.dataset.debug === "1");
  const debug = (level, msg, data) => {
    if (!DEBUG) return;
    try { secureDevLog(level, "crypto-benchmark", msg, data); } catch {}
  };
  debug("info", "mountCryptoBenchmark: start", { hasCurrent: Boolean(current) });
  const lang = (langInput || current?.dataset.lang) === "ru" ? "ru" : "en";
  const i18n = lang === "ru" ? TEXT.ru : TEXT.en;
  // Prefer caller-provided endpoint, fallback to same-origin BFF default
  const COLLECTOR_URL = collectorUrl || "/api/submit";
  // Per Security Constitution 2.7, client-side secrets are forbidden
  const COLLECTOR_SECRET = "";

  let btnStart, btnAbort, btnRetry, btnCsv, btnJson, btnSubmit, statusEl, barEl, tbody, analysis;
  // Single-mode orchestrator state (v8.0)
  let runId = "";
  try {
    btnStart = $(section, ".btn-start");
    btnAbort = $(section, ".btn-abort");
    btnRetry = $(section, ".btn-retry");
    btnCsv = $(section, ".btn-download-csv");
    btnJson = $(section, ".btn-download-json");
    btnSubmit = $(section, ".btn-submit");
    statusEl = $(section, ".status");
    barEl = $(section, ".bar");
    tbody = $(section, ".tbody");
    analysis = $(section, ".analysis");
    debug("info", "elements bound", {
      btnStart: !!btnStart, btnAbort: !!btnAbort, btnRetry: !!btnRetry,
      btnCsv: !!btnCsv, btnJson: !!btnJson, btnSubmit: !!btnSubmit,
      statusEl: !!statusEl, barEl: !!barEl, tbody: !!tbody, analysis: !!analysis
    });
  } catch (e) {
    // Reset paired-run state and abort mount
  // Removed accidental global leak of benchmarkState per Security Constitution
    try { console.error(e); } catch {}
    return null;
  }

  function finalizeUIAndEnableButtons(finalResults) {
    try {
      const stable = analyzeRunQuality(finalResults);
      setStatus(statusEl, stable ? i18n.done : i18n.unstableDetected);
      // Avoid inline styles per Tailwind v4 tokens mandate; toggle a semantic utility class
  const dangerClass = "text-[var(--color-danger,red)]";
      statusEl.classList.toggle(dangerClass, !stable);
      analysis.classList.toggle(dangerClass, !stable);
      setDisabled(btnRetry, false);
      setDisabled(btnCsv, false);
      setDisabled(btnJson, false);
      setDisabled(btnSubmit, !COLLECTOR_URL);
      if (!stable) {
        analysis.textContent = i18n.unstableDetected + (!COLLECTOR_URL ? ` ${i18n.submitDisabled}` : "");
        applyRetryPrimaryStyle();
        btnSubmit.classList.remove("results-ready");
      } else {
        analysis.textContent = !COLLECTOR_URL ? i18n.submitDisabled : "";
        clearRetryPrimaryStyle();
        if (COLLECTOR_URL) btnSubmit.classList.add("results-ready");
      }
      setDisabled(btnAbort, true);
      btnStart.classList.add("inactive");
      updateBar(barEl, 100);
    } catch {}
  }

  // Runtime environment assertions (Trusted Types presence per Security Constitution)
  try {
    // No-op: we already fall back gracefully if Trusted Types is not enforced
  } catch {}

  // Cross-origin isolation previously required for SAB; no hard requirement now.
  // If missing, continue with graceful degradation (no SAB usage).

  if (!crypto?.subtle?.digest) {
    setStatus(statusEl, i18n.notSupported);
    setDisabled(btnStart, true);
    return null;
  }

  let aborted = false;
  let last = null;
  let envCache = null;
  let worker = null;
  const abort = new AbortController();
  let firstMessageReceived = false;
  const runMeta = { timerGranularityMs: 0, sabOverheadMs: 0, crossOriginIsolated: false };
  // Run-scoped cleanup hook (set inside run())
  let clearRunResources = () => {};

  // Apply the same highlight effect as Submit by toggling the shared 'results-ready' class
  function applyRetryPrimaryStyle() {
    try {
      // Reuse the exact styling/animation targeted by .btn-submit.results-ready
      btnRetry.classList.add("btn-submit", "results-ready");
    } catch {}
  }
  function clearRetryPrimaryStyle() {
    try {
      btnRetry.classList.remove("btn-submit", "results-ready");
    } catch {}
  }

  function resetUI() {
    tbody.textContent = "";
    analysis.textContent = "";
    updateBar(barEl, 0);
    setDisabled(btnAbort, true);
    setDisabled(btnRetry, true);
    setDisabled(btnCsv, true);
    setDisabled(btnJson, true);
    setDisabled(btnSubmit, true);
    
    // Reset button states
    btnStart.classList.remove("inactive");
    btnSubmit.classList.remove("results-ready");
    btnRetry.classList.remove("results-ready");
  clearRetryPrimaryStyle();
    // Reset orchestrator state
    runId = "";
  }

  async function run() {
  const runAbort = new AbortController();
    aborted = false;
    firstMessageReceived = false;

    // Always start a fresh sequence
    resetUI();
    runId = await createRunId();

    setDisabled(btnStart, true);
    setDisabled(btnAbort, false);

    const totalCells = CONFIG.algos.length * CONFIG.sizes.length;
    setStatus(statusEl, i18n.running);
    // Allow degraded mode when not cross-origin isolated (no SAB)
    const coi = Boolean(globalThis.crossOriginIsolated);
    if (!coi) {
      debug("info", "cross-origin isolation not present; running in degraded mode (no SAB).", {});
    }

  if (worker) { try { worker.terminate(); } catch {} worker = null; }
    try {
      const trustedURL = getTrustedWorkerURL();
      debug("info", "worker url computed", {
        raw: workerURL,
        trustedEmpty: !trustedURL,
        sameOrigin: (() => { try { return new URL(workerURL, location.origin).origin === location.origin; } catch { return null; } })(),
      });
      // If policy blocked, trustedURL may be empty; handle gracefully
      if (!trustedURL) {
        throw new Error("Worker URL blocked by Trusted Types policy");
      }
      worker = new Worker(trustedURL, { type: "module", name: "crypto-benchmark" });
      debug("info", "worker constructed", {});
      try {
        worker.addEventListener("error", (ev) => {
          debug("error", "worker error", {
            message: ev?.message, filename: ev?.filename, lineno: ev?.lineno, colno: ev?.colno
          });
          setStatus(statusEl, `Worker error: ${String(ev?.message || "unknown")}`);
        }, { signal: runAbort.signal });
        worker.addEventListener("messageerror", (ev) => {
          debug("error", "worker messageerror", { data: String(ev?.data || "") });
          setStatus(statusEl, "Worker message error (serialization)");
        }, { signal: runAbort.signal });
      } catch {}
    } catch (err) {
      setStatus(statusEl, String(err?.message || err));
      debug("error", "worker construction failed", { err: String(err) });
      setDisabled(btnAbort, true);
      setDisabled(btnStart, false);
      updateBar(barEl, 0);
      return;
    }
    const watchdog = setTimeout(() => {
      if (!firstMessageReceived) {
        debug("warn", "watchdog: no messages from worker within 5000ms", {});
        setStatus(statusEl, "Worker did not respond; check CSP/TT logs and network");
      }
    }, 5000);
    // Expose a run-scoped cleanup that also clears watchdog
    clearRunResources = () => {
      try { clearTimeout(watchdog); } catch {}
      try { runAbort.abort(); } catch {}
    };

    // Allocate SAB ring buffer for silent per-batch streaming (only if COI)
    const CTRL_INTS = 8; // VERSION, FLAGS, WR_HEAD, COMMITTED, DROPPED, RUN_ID_LOW, RUN_ID_HIGH, PAD(for 8-byte alignment)
    let sab = null;
    let ctrl = null;
    let sabData = null;
    let capacityPow2 = 0;
    if (coi) {
      try {
        const maxSamples = Math.max(1, totalCells * CONFIG.PER_CELL_MAX_BATCHES);
        const pow = Math.ceil(Math.log2(Math.max(1, maxSamples)));
        const MAX_EXP = 20; // cap at 2^20 samples
        const exp = Math.min(pow, MAX_EXP);
        capacityPow2 = Math.pow(2, exp);
        const ctrlBytes = Int32Array.BYTES_PER_ELEMENT * CTRL_INTS;
        const dataBytes = Float64Array.BYTES_PER_ELEMENT * capacityPow2;
        const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB safety cap
        if (ctrlBytes + dataBytes > MAX_TOTAL_BYTES) {
          throw new Error("SAB allocation would exceed memory cap; disabling SAB.");
        }
        sab = new SharedArrayBuffer(ctrlBytes + dataBytes);
        ctrl = new Int32Array(sab, 0, CTRL_INTS);
        sabData = new Float64Array(sab, ctrlBytes);
        // Initialize header
        Atomics.store(ctrl, 0, 1); // VERSION
        Atomics.store(ctrl, 1, 0); // FLAGS
        Atomics.store(ctrl, 2, 0); // WR_HEAD
        Atomics.store(ctrl, 3, 0); // COMMITTED
        Atomics.store(ctrl, 4, 0); // DROPPED
        Atomics.store(ctrl, 5, 0); // RUN_ID_LOW (unused)
        Atomics.store(ctrl, 6, 0); // RUN_ID_HIGH (unused)
      } catch (e) {
        debug("warn", "SAB allocation failed; continuing without SAB", { err: String(e) });
        sab = null; ctrl = null; sabData = null; capacityPow2 = 0;
      }
    }

    const results = [];
  const onMessage = async (e) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      firstMessageReceived = true;
      debug("info", "worker message", { type: data.type });
  if (data.type === "progress") {
        if (typeof data.completed === "number" && typeof data.total === "number") {
          updateBar(barEl, (data.completed / totalCells) * 100);
        }
        if (typeof data.message === "string") setStatus(statusEl, data.message);
        if (typeof data.timerGranularityMs === "number") {
          runMeta.timerGranularityMs = data.timerGranularityMs;
        }
      } else if (data.type === "result") {
        results.push(data.payload);
        tbody.appendChild(buildRow(data.payload, i18n));
        updateBar(barEl, (results.length / totalCells) * 100);
      } else if (data.type === "ready") {
        debug("info", "worker ready", {});
      } else if (data.type === "log") {
        debug("info", "worker log", data);
  } else if (data.type === "done") {
  try { worker?.removeEventListener?.("message", onMessage); } catch {}
    // Ensure per-run cleanup executes (clears watchdog and detaches run-scoped listeners)
    try { clearRunResources(); } catch {}
        if (aborted) {
          // User aborted; don't proceed with orchestration
          return;
        }
        debug("info", "done: completed", {});
        // SAB diagnostics
        try {
          if (ctrl && sabData && capacityPow2 > 0) {
            const committed = Atomics.load(ctrl, 3);
            const dropped = Atomics.load(ctrl, 4);
            const lastSample = committed > 0 ? sabData[(committed - 1) & (capacityPow2 - 1)] : null;
            debug("info", "SAB diagnostics", { committed, dropped, lastSample });
          }
        } catch {}
        // Merge meta if present
        try {
          if (data.meta && typeof data.meta === "object") {
            Object.assign(runMeta, data.meta);
          }
        } catch {}
        try {
          if (DEBUG && runMeta.debugSeedFingerprint) {
            secureDevLog("debug", "crypto-benchmark", "debugSeedFingerprint", { id: String(runMeta.debugSeedFingerprint) });
          }
        } catch {}
        // Finalize single-run scenario
        last = {
          timestamp: new Date().toISOString(),
          scriptVersion: SCRIPT_VERSION,
          runId: runId || (await createRunId()),
          env: { ...(envCache || (envCache = await getEnv(lang))) },
          results,
        };
        // Update analysis meta display
        try {
          analysis.textContent = `Timer granularity: ${(runMeta.timerGranularityMs || 0).toFixed(4)} ms • SAB overhead: ${(runMeta.sabOverheadMs || 0).toFixed(6)} ms`;
        } catch {}
  // Pre-enable submit ASAP to avoid race with async env probing in tests
  try { setDisabled(btnSubmit, !COLLECTOR_URL); } catch {}
        finalizeUIAndEnableButtons(results);
    } else if (data.type === "error") {
        setStatus(statusEl, String(data.error || "Error"));
        setDisabled(btnRetry, false);
        setDisabled(btnAbort, true);
        setDisabled(btnStart, false);
        setDisabled(btnSubmit, true);
        updateBar(barEl, 100);
  try { worker?.removeEventListener?.("message", onMessage); } catch {}
    try { clearRunResources(); } catch {}
      }
    };
  worker.addEventListener("message", onMessage, { signal: runAbort.signal });
    debug("info", "posting measure command", { algos: CONFIG.algos.length, sizes: CONFIG.sizes.length });
    const cfg = {
        algos: CONFIG.algos,
        sizes: CONFIG.sizes,
        warmupIters: CONFIG.warmupIters,
        measureIters: CONFIG.measureIters,
        TOTAL_BUDGET_MS: CONFIG.TOTAL_BUDGET_MS,
        CALIBRATION_ITERS: CONFIG.CALIBRATION_ITERS,
        TARGET_BATCH_MS: CONFIG.TARGET_BATCH_MS,
        MIN_RECORDED_BATCHES: CONFIG.MIN_RECORDED_BATCHES,
        PER_CELL_MAX_BATCHES: CONFIG.PER_CELL_MAX_BATCHES,
        CV_FLAG_THRESHOLD: CONFIG.CV_FLAG_THRESHOLD,
        CV_STOP_THRESHOLD: CONFIG.CV_STOP_THRESHOLD,
        MAX_REMEDIATION_ATTEMPTS: CONFIG.MAX_REMEDIATION_ATTEMPTS,
        PER_BATCH_SAMPLE_LIMIT: CONFIG.PER_BATCH_SAMPLE_LIMIT,
        poolSize: CONFIG.poolSize,
        modeRequested: coi ? "cross_isolated" : "degraded",
        pairedRunId: "",
        crossOriginIsolated: coi,
        isMobile: isMobile(),
        DEBUG: DEBUG,
        includePerBatchInPayload: DEBUG === true,
      };
    if (sab && capacityPow2 > 0) {
      cfg.sab = sab;
      cfg.sabCapacity = capacityPow2;
    }
    worker.postMessage({ cmd: "measure", cfg });

    // Abort run if tab is backgrounded (data integrity)
    const visibilityHandler = () => {
      try {
        if (document.visibilityState === 'hidden') {
          console.warn('[Benchmark]: Tab backgrounded. Aborting run to ensure data integrity.');
          try { secureDevLog("warn", "crypto-benchmark", "Tab backgrounded; aborting run to preserve data integrity", {}); } catch {}
          aborted = true;
          try { worker?.terminate(); worker = null; } catch {}
          setStatus(statusEl, 'Benchmark aborted: Tab was moved to the background.');
      try { clearRunResources(); } catch {}
          document.removeEventListener('visibilitychange', visibilityHandler);
        }
      } catch {}
    };
    document.addEventListener('visibilitychange', visibilityHandler, { once: false, signal: runAbort.signal });
  }

  // NOTE: Second run is triggered by calling run() again after the first completes (no helper needed)

  btnStart.addEventListener("click", run, { signal: abort.signal });
  btnRetry.addEventListener("click", () => { resetUI(); run(); }, { signal: abort.signal });
  btnAbort.addEventListener(
    "click",
    () => {
  aborted = true;
  try { worker?.terminate(); worker = null; } catch {}
  debug("info", "abort: user requested", {});
  setStatus(statusEl, i18n.aborted);
  setDisabled(btnAbort, true);
  // Clear any run-scoped resources (e.g., watchdog, listeners)
  try { clearRunResources(); } catch {}
  // Defer the full UI reset to a new macrotask to avoid race with in-flight messages
  setTimeout(resetUI, 0);
    },
    { signal: abort.signal },
  );
  btnCsv.addEventListener("click", () => {
    if (!last) return;
    download("browser-hash-benchmark.csv", toCSV(last.results));
  }, { signal: abort.signal });
  btnJson.addEventListener("click", () => {
    if (!last) return;
    download("browser-hash-benchmark.json", JSON.stringify(last, null, 2));
  }, { signal: abort.signal });
  btnSubmit.addEventListener("click", async () => {
    if (!last || !COLLECTOR_URL) return;
    try {
      setStatus(statusEl, i18n.submitting);
      // Build secure, trimmed payload per Security Constitution
      const stable = analyzeRunQuality(last.results);
      const env = { ...(last.env || {}) };
      // Ensure we don't transmit deprecated/diagnostic fields
      try { delete env.visibilityState; } catch {}
      try { delete env.connection; } catch {}
      const includeHiEntropy = (Boolean(import.meta?.env?.DEV) || (document.currentScript?.dataset?.debug === "1"));
      const payload = {
        runId: last.runId,
        scriptVersion: last.scriptVersion,
        isStable: stable,
        // Flatten env
        anonId: env.anonId ?? null,
        origin: env.origin ?? null,
        userAgent: env.userAgent ?? null,
        platform: env.platform ?? null,
        hardwareConcurrency: env.hardwareConcurrency ?? null,
        deviceMemory: env.deviceMemory ?? null,
        userAgentData: includeHiEntropy && env.userAgentData ? JSON.stringify(env.userAgentData) : null,
        battery: includeHiEntropy && env.battery ? JSON.stringify(env.battery) : null,
        timerGranularityMs: runMeta.timerGranularityMs ?? null,
        sabOverheadMs: runMeta.sabOverheadMs ?? null,
        results: last.results.map(({ perBatchMs, calibrationTimeMs, timerGranularityMs, mode, pairedRunId, crossOriginIsolated, ...rest }) => rest),
      };
      const res = await fetch(COLLECTOR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // Do not send credentials by default; expect strict CORS on the collector
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setStatus(statusEl, i18n.submitted);
      secureDevLog("info", "crypto-benchmark", "submitted", { status: res.status });
    } catch (err) {
      setStatus(statusEl, String(err?.message || err));
      // Allow retry instead of permanently disabling submit
      secureDevLog("error", "crypto-benchmark", "submit failed", { err: String(err) });
    }
  }, { signal: abort.signal });

  const api = {
    destroy() {
      try { abort.abort(); } catch {}
      try { worker?.terminate(); } catch {}
      MOUNTED.delete(section);
    },
  };

  MOUNTED.set(section, api);
  return api;
}

// Auto-mount
try {
  const current = document.currentScript;
  const section = current?.closest?.("section");
  if (section) mountCryptoBenchmark(section, { scriptEl: current });
} catch (e) {
  console.error(e);
}
