/* A seeded generator, so a run is reproducible from its config alone (AMLSim's random_seed).
   mulberry32: small, fast, good enough for sampling; not for anything cryptographic. */
export function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    float: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),            // inclusive
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    sample(arr, k) {                                                    // without replacement
      const a = arr.slice(); k = Math.min(k, a.length);
      for (let i = 0; i < k; i++) { const j = i + Math.floor(next() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
      return a.slice(0, k);
    },
    shuffle(arr) { return rng.sample(arr, arr.length); },
    hex(n) { let s = ""; while (s.length < n) s += Math.floor(next() * 16).toString(16); return s; },
    /* AMLSim's two amount helpers: RandomAmount is uniform; RoundedAmount is uniform then rounded to a
       "round" figure, the way a person types 150 rather than 148.37. We round to two significant digits. */
    amount: (lo, hi) => +(lo + (hi - lo) * next()).toFixed(6),
    rounded(lo, hi) { const x = lo + (hi - lo) * next(); const m = Math.pow(10, Math.max(0, Math.floor(Math.log10(x)) - 1)); return Math.max(lo, Math.round(x / m) * m); }
  };
  return rng;
}
