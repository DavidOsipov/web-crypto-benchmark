// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2025 David Osipov <personal@david-osipov.vision>
// Author Website: https://david-osipov.vision
// Author ISNI: 0000 0005 1802 960X
// Author ISNI URL: https://isni.org/isni/000000051802960X
// Author ORCID: 0009-0005-2713-9242
// Author VIAF: 139173726847611590332
// Author Wikidata: Q130604188
// Version: 4.5.1
// Shared statistics helpers for the crypto benchmark
import { getSecureRandom } from "@utils/security-kit.js";

export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

export function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a.at(mid) : ((a.at(mid - 1) ?? 0) + (a.at(mid) ?? 0)) / 2;
}

export function stddev(arr, m) {
  const mu = m ?? mean(arr);
  const variance = mean(arr.map((x) => (x - mu) ** 2));
  return Math.sqrt(variance);
}

export function ci95(arr) {
  const mu = mean(arr);
  const sd = stddev(arr, mu);
  const n = arr.length;
  if (n <= 1) return [mu, mu];
  const half = 1.96 * (sd / Math.sqrt(n));
  return [mu - half, mu + half];
}

// Coefficient of Variation: std / mean. Returns 0 for empty or zero-mean inputs.
export function coefficientOfVariation(arr, precomputedMean) {
  const mu = precomputedMean ?? mean(arr);
  if (!isFinite(mu) || mu === 0) return 0;
  const sd = stddev(arr, mu);
  return sd / mu;
}

// Quantile with linear interpolation (inclusive). q in [0,1].
export function quantile(arr, q) {
  if (!arr?.length) return 0;
  if (q <= 0) return Math.min(...arr);
  if (q >= 1) return Math.max(...arr);
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = a.at(base);
  const hi = a.at(base + 1) ?? lo;
  return lo + rest * (hi - lo);
}

// Convenience helper for quartiles. Returns [q25, q75].
export function quartiles(arr) {
  return [quantile(arr, 0.25), quantile(arr, 0.75)];
}

// Median-of-Means estimator. Partitions arr into k groups using an
// interleaved strategy to be robust against time-series trends in the data.
export function medianOfMeans(arr, k = 5) {
  const n = Array.isArray(arr) ? arr.length : 0;
  if (n === 0) return 0;
  
  const groups = Math.max(1, Math.min(k | 0, n));
  if (groups === 1) return mean(arr);

  const groupMeans = Array(groups).fill(0);
  const groupCounts = Array(groups).fill(0);

  // Use interleaved (round-robin) assignment to form groups.
  // This decorrelates the groups from time-series trends (e.g., thermal throttling).
  for (let i = 0; i < n; i++) {
    const groupIndex = i % groups;
    // Validate index (allowlist) before dynamic access to satisfy security rules
    if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex >= groups) continue;
    // eslint-disable-next-line security/detect-object-injection
    groupMeans[groupIndex] += arr[i];
    // eslint-disable-next-line security/detect-object-injection
    groupCounts[groupIndex]++;
  }

  for (let g = 0; g < groups; g++) {
    // eslint-disable-next-line security/detect-object-injection
    if (groupCounts[g] > 0) {
      // eslint-disable-next-line security/detect-object-injection
      groupMeans[g] /= groupCounts[g];
    }
  }
  
  return median(groupMeans);
}

// Non-parametric bootstrap 95% CI for the mean of arr. Returns [low, high].
export function bootstrapCI(arr, num_samples = 2000) {
  const n = Array.isArray(arr) ? arr.length : 0;
  if (n === 0) return [0, 0];
  const means = [];
  for (let s = 0; s < num_samples; s++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
  // Use project-secure RNG to comply with Security Constitution; performance impact is negligible here
  const u = getSecureRandom(); // 0 <= u < 1
      const idx = Math.floor(u * n);
      acc += arr.at(idx) ?? 0;
    }
    means.push(acc / n);
  }
  means.sort((x, y) => x - y);
  const loIdx = Math.max(0, Math.floor(num_samples * 0.025) - 1);
  const hiIdx = Math.min(num_samples - 1, Math.floor(num_samples * 0.975));
  return [means.at(loIdx) ?? means[0], means.at(hiIdx) ?? means[means.length - 1]];
}
