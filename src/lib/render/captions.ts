// Captions and titles (spec §9.2): text drawn with Canvas 2D into a texture, composited last.
// Fonts are bundled (system-ui fallback), never fetched at runtime.
import type { Caption } from "$lib/planner/types";

export interface TextTex { canvas: OffscreenCanvas | HTMLCanvasElement; w: number; h: number }

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}

const cache = new Map<string, TextTex>();

/** Render a caption into a canvas sized to the output frame. */
export function renderText(text: string, style: Caption["style"], position: Caption["position"], w: number, h: number, sub?: string): TextTex {
  const key = `${text}|${sub ?? ""}|${style}|${position}|${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);
  const scale = h / 1080;
  const size = (style === "title" ? 88 : style === "chapter" ? 46 : 40) * scale;
  ctx.font = `${style === "title" ? 600 : 500} ${size}px "Lantern Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = 18 * scale;
  ctx.shadowOffsetY = 2 * scale;
  ctx.fillStyle = "#fff";
  const lines = wrap(ctx, text, w * 0.8);
  const lh = size * 1.25;
  const y0 = position === "center" ? h / 2 - ((lines.length - 1) * lh) / 2 : position === "top" ? h * 0.1 + size : h * 0.9 - (lines.length - 1) * lh - size * 0.2;
  lines.forEach((l, i) => ctx.fillText(l, w / 2, y0 + i * lh));
  if (sub) {
    ctx.font = `400 ${size * 0.42}px "Lantern Sans", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(sub, w / 2, y0 + lines.length * lh + size * 0.1);
  }
  const t = { canvas: c, w, h };
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  cache.set(key, t);
  return t;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const t = line ? line + " " + word : word;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/** Title animation alpha and rise (fraction of frame height) for time x in [0, 1] of the card. */
export function titleAnim(kind: "fade" | "rise" | "type", x: number, dur: number): { alpha: number; dy: number; chars: number } {
  const fin = Math.min(0.35, 0.9 / dur), fout = Math.min(0.35, 0.9 / dur);
  const a = x < fin ? x / fin : x > 1 - fout ? (1 - x) / fout : 1;
  const e = a * a * (3 - 2 * a);
  return { alpha: e, dy: kind === "rise" ? (1 - e) * 0.02 : 0, chars: kind === "type" ? e : 1 };
}
