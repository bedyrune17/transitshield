// Deterministic 32-bit PRNG (mulberry32). Bit-identical port of
// backend/shared/prng.py - all arithmetic is kept in unsigned 32-bit range.

export class Mulberry32 {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  nextU32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0)) >>> 0)) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  random() {
    return this.nextU32() / 4294967296;
  }

  /** Inclusive integer in [lo, hi]. */
  randint(lo, hi) {
    return lo + (this.nextU32() % (hi - lo + 1));
  }

  choice(items) {
    return items[this.randint(0, items.length - 1)];
  }

  /** True with probability perMille / 1000. */
  chance(perMille) {
    return this.randint(0, 999) < perMille;
  }

  /** Deterministic sample without replacement (partial Fisher-Yates). */
  sample(items, k) {
    const pool = items.slice();
    const n = Math.min(k, pool.length);
    for (let i = 0; i < n; i++) {
      const j = this.randint(i, pool.length - 1);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, n);
  }
}

/** Exact floor division for integers (matches Python's //). */
export function idiv(a, b) {
  const r = a % b;
  let q = (a - r) / b;
  if (r !== 0 && (r < 0) !== (b < 0)) q -= 1;
  return q;
}
