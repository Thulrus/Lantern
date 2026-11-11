// Seeded pseudo-random numbers (spec §3: the planner is deterministic; all randomness comes from
// a seed stored in the project). SplitMix32 to spread the seed, then xoshiro128** for the stream.

export class Prng {
  private s0: number; private s1: number; private s2: number; private s3: number;

  constructor(seed: number) {
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next(); this.s1 = next(); this.s2 = next(); this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform in [0, 1). */
  next(): number {
    const r = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0; this.s3 ^= this.s1; this.s1 ^= this.s2; this.s0 ^= this.s3;
    this.s2 ^= t; this.s3 = rotl(this.s3, 11);
    return r / 4294967296;
  }

  /** Uniform in [lo, hi). */
  uniform(lo = 0, hi = 1): number { return lo + (hi - lo) * this.next(); }

  /** Integer in [0, n). */
  int(n: number): number { return Math.floor(this.next() * n); }

  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]; }

  /** Index drawn with the given (non-negative) weights. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.int(weights.length);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }

  /** A child stream for one slide, so changes elsewhere don't reshuffle its choices. */
  fork(tag: string): Prng {
    let h = 2166136261;
    for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 16777619);
    return new Prng((h ^ this.int(0x7fffffff)) >>> 0);
  }
}

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/** FNV-1a of a string, for stable ids and per-slide seeds. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
