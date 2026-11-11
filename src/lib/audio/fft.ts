// Radix-2 real FFT (iterative, in place) for the music analysis. Sizes are powers of two.
export class FFT {
  private rev: Uint32Array; private cos: Float32Array; private sin: Float32Array;
  constructor(public n: number) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((-2 * Math.PI * i) / n); this.sin[i] = Math.sin((-2 * Math.PI * i) / n); }
  }
  /** Forward transform of real input; returns magnitude spectrum (n/2 + 1 bins). */
  magnitude(input: Float32Array, re: Float32Array, im: Float32Array, out: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) { re[i] = input[this.rev[i]] ?? 0; im[i] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size)
        for (let j = 0; j < half; j++) {
          const k = j * step, c = this.cos[k], s = this.sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
  }
}
