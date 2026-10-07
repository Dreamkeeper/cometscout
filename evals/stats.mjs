// Small numbers for the evals: a seeded random generator, a seeded shuffle, rates with their counts, and the exact
// McNemar test for two systems judged on the same labelled jobs. No dependencies, no I/O.

/** mulberry32: the same seed gives the same sequence on every platform. Returns a function giving [0, 1). */
export function rng(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A shuffled copy (Fisher-Yates) driven by `rand`. */
export function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** { value, num, den }: value is null when den is 0. */
export const rate = (num, den) => ({ value: den ? num / den : null, num, den });
/** "0.75 (6 of 8)", or "n/a (0 of 0)". */
export const rateText = r => `${r.value == null ? 'n/a' : r.value.toFixed(2)} (${r.num} of ${r.den})`;

/**
 * Exact two-sided McNemar test: b and c are the discordant pairs (A right and B wrong, A wrong and B right). Under
 * the null each discordant pair is a fair coin, so p = 2 * P(X <= min(b, c)) for X ~ Binomial(b + c, 1/2), at most 1.
 * Above 1000 discordant pairs it is summed in log space, so a large n does not underflow.
 */
export function mcnemarExact(b, c) {
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0;
  if (n <= 1000) { let term = 0.5 ** n; for (let i = 0; i <= k; i++) { p += term; term = term * (n - i) / (i + 1); } }   // exact for small counts
  else { let logTerm = -n * Math.LN2; for (let i = 0; i <= k; i++) { p += Math.exp(logTerm); logTerm += Math.log((n - i) / (i + 1)); } }
  return Math.min(1, 2 * p);
}
