// src/lib/prng.js
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2025 David Osipov <personal@david-osipov.vision>
// Author Website: https://david-osipov.vision
// Author ISNI: 0000 0005 1802 960X
// Author ISNI URL: https://isni.org/isni/000000051802960X
// Author ORCID: 0009-0005-2713-9242
// Author VIAF: 139173726847611590332
// Author Wikidata: Q130604188
/**
 * Fast, seeded PRNG utilities for the benchmark. Seeded once from a cryptographic source.
 * This module is designed to be shared between the main thread and worker contexts.
 */

/**
 * Creates a fast, deterministic mulberry32 PRNG function.
 * @param {number} seed - A 32-bit integer seed.
 * @returns {() => number} A function that returns a random float between 0 and 1.
 */
export function mulberry32(seed) {
  // Ensure 32-bit signed integer behavior for the seed operations
  return function() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a new PRNG instance seeded with a value from the Web Crypto API.
 * This is the ONLY function that should be used to initialize a PRNG.
 * @returns {{prng: () => number, seedBuffer: Uint32Array}} An object containing the PRNG function and its original seed buffer.
 */
export function createCryptoSeededPRNG() {
  const seedBuffer = new Uint32Array(1);
  try {
    // Isomorphic crypto access for browser, worker, etc.
    const crypto = typeof self !== 'undefined' ? self.crypto : globalThis.crypto;
    crypto.getRandomValues(seedBuffer);
  } catch (e) {
  // Per rule 1.4, fail loudly in logs but provide a safe, non-crashing fallback.
  // IMPORTANT: Do NOT use Math.random(); derive a deterministic, low-entropy seed instead.
  console.error('[Security]: Web Crypto API for PRNG seed failed. Falling back to time-based seed.', e);
  const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // Mix coarse and high-res time sources; still non-crypto and marked as degraded.
  const fallbackSeed = ((Date.now() & 0xffffffff) ^ ((t * 1000) | 0)) >>> 0;
  seedBuffer[0] = fallbackSeed || 0xA5A5A5A5; // ensure non-zero default
  }
  return {
      prng: mulberry32(seedBuffer[0]),
      seedBuffer: seedBuffer
  };
}

/**
 * Optionally derive a short, privacy-preserving fingerprint of the seed buffer for debug builds.
 * Uses SHA-256 and returns the first `bytes` as a hex string. Returns null if no crypto is available.
 * NOTE: This must remain strictly opt-in and never be transmitted by default.
 * @param {Uint32Array} seedBuffer
 * @param {number} bytes Number of bytes to include from the digest (default 8 -> 16 hex chars)
 * @returns {Promise<string|null>} Hex string or null on unavailable crypto
 */
export async function seedFingerprintHex(seedBuffer, bytes = 8) {
  try {
    const crypto = (typeof self !== 'undefined' ? self.crypto : globalThis.crypto);
    const subtle = crypto?.subtle;
    if (subtle?.digest && seedBuffer && seedBuffer.buffer) {
      // Include a domain separator to avoid cross-protocol reuse of the same seed
      const prefix = new TextEncoder().encode('PRNG:v1\n');
      const seedBytes = new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength);
      const data = new Uint8Array(prefix.length + seedBytes.length);
      data.set(prefix, 0);
      data.set(seedBytes, prefix.length);
      const digest = await subtle.digest('SHA-256', data);
      const view = new Uint8Array(digest);
      const n = Math.max(1, Math.min(bytes | 0, view.length));
      let out = '';
      for (let i = 0; i < n; i++) {
        const byte = view.at(i) ?? 0;
        out += byte.toString(16).padStart(2, '0');
      }
      return out;
    }
  } catch {}
  // Node fallback (tests): try dynamic import without breaking browsers
  try {
    // @ts-ignore - node:crypto not available in browsers; guarded by try/catch
    const mod = await import('node:crypto');
    if (mod?.createHash && seedBuffer) {
      const h = mod.createHash('sha256');
      h.update('PRNG:v1\n');
      h.update(Buffer.from(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength));
      const hex = h.digest('hex');
      const nChars = Math.max(2, (bytes | 0) * 2);
      return hex.slice(0, nChars);
    }
  } catch {}
  return null;
}
