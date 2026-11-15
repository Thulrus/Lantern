// Synthetic test photos drawn in the page (no real photos in the repo, spec §12): bright
// gradients with a few blocks laid out from the hue, so no two are near-duplicates.
import type { Page } from "@playwright/test";

export type Spec = [name: string, w: number, h: number, hue: number];

export async function syntheticPhotos(page: Page, specs: Spec[]): Promise<{ name: string; mimeType: string; buffer: Buffer }[]> {
  const files = await page.evaluate(async (specs) => {
    const make = async ([name, w, h, hue]: [string, number, number, number]) => {
      const c = new OffscreenCanvas(w, h), g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${hue} 70% 75%)`); grad.addColorStop(1, `hsl(${hue + 40} 70% 65%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      for (let k = 0; k < 12; k++) { g.fillStyle = `hsl(${hue + k * 25} 60% ${55 + (k % 3) * 10}%)`; g.fillRect(((k * 37 + hue) % 10) * w / 10, ((k * (53 + hue)) % 11) * h / 11, w / (4 + (k + hue) % 5), h / (5 + (k * hue) % 4)); }
      const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      const bytes = new Uint8Array(await b.arrayBuffer());
      let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return { name, b64: btoa(s) };
    };
    return Promise.all(specs.map(make));
  }, specs);
  return files.map((f) => ({ name: f.name, mimeType: "image/jpeg", buffer: Buffer.from(f.b64, "base64") }));
}
