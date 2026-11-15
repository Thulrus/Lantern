// Depth wipe into a slide that does not fill the frame (a portrait pair with its gutter, a lone
// tall portrait with letterbox bars; a square photo is cover-fitted, so it has none): the incoming slide's empty regions must not appear on the first
// frames and cut the outgoing photo to the next slide's shape (owner's observation, 2026-11-14).
// Uses synthetic photos made in the page, so it runs without example_photos/.
import { expect, test } from "@playwright/test";
import { syntheticPhotos } from "./synthetic";

test("depth wipe does not show the next slide's bars or gutter early", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  // Bright, distinct photos: landscapes, two portraits (they pair), a square, a lone tall portrait.
  const files = await syntheticPhotos(page, [["a1.jpg", 1600, 900, 10], ["a2.jpg", 1600, 900, 200], ["b1.jpg", 900, 1600, 100],
    ["b2.jpg", 900, 1600, 280], ["c1.jpg", 1200, 1200, 50], ["d1.jpg", 1600, 900, 160], ["e1.jpg", 700, 1600, 330]]);
  await page.locator('input[type="file"][multiple]').first().setInputFiles(files);
  await page.waitForURL(/#\/make\//, { timeout: 60_000 });
  await page.getByText("Make my show").click();
  await page.waitForURL(/#\/edit\//);
  await expect(page.locator(".board .card").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => (globalThis as any).lanternPlayer, null, { timeout: 30_000 }); // eslint-disable-line

  const got = await page.evaluate(async () => {
    type Any = any; // eslint-disable-line
    const app = (globalThis as Any).lantern, p = (globalThis as Any).lanternPlayer;
    const canvas = document.querySelector(".stage canvas") as HTMLCanvasElement;
    // Every slide (after the first) that leaves part of a 16:9 frame empty gets a depth wipe in.
    const targets = app.project.slides.map((s: Any, k: number) => ({ s, k })).filter(({ s, k }: Any) => {
      if (k === 0) return false;
      if (s.kind === "pair") return true;
      const m = s.kind === "photo" && app.analysis.get(s.items[0]);
      return m && Math.abs(m.info.w / m.info.h - 16 / 9) > 0.2;
    }).map(({ s }: Any) => s.id);
    app.edit((pr: Any) => { for (const s of pr.slides) if (targets.includes(s.id)) s.transitionIn = { type: "depthWipe", dur: 1.5 }; });
    const grab = () => {
      const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
      const g = c.getContext("2d")!; g.drawImage(canvas, 0, 0);
      return g.getImageData(0, 0, c.width, c.height).data;
    };
    const out: { id: string; kind: string; maxDiff: number }[] = [];
    for (const id of targets) {
      const tl = app.timeline, l = tl.layers.find((x: Any) => x.id === id);
      const t = l.enter.t0 + 0.12 * (l.enter.t1 - l.enter.t0);
      await p.assets.ensure(tl, t);
      canvas.width = 640; canvas.height = 360;
      p.renderer.draw(tl, t);
      const wipe = grab();
      // The same moment as a crossfade: almost all outgoing photo this early (smooth(0.12) ≈ 4 %).
      const tl2 = { ...tl, layers: tl.layers.map((x: Any) => (x.id === id ? { ...x, enter: { ...x.enter, type: "crossfade" } } : x)) };
      p.renderer.draw(tl2, t);
      const fade = grab();
      // Compare the columns where the incoming slide has no photo: the gutter, or the bars.
      const slide = app.project.slides.find((s: Any) => s.id === id);
      const cols: number[] = [];
      if (slide.kind === "pair") for (let x = 318; x <= 321; x++) cols.push(x);
      else { const m = app.analysis.get(slide.items[0]); const half = Math.round((360 * m.info.w / m.info.h) / 2); for (let x = 4; x < 320 - half - 4; x += 6) { cols.push(x); cols.push(639 - x); } }
      let maxDiff = 0;
      for (const x of cols) for (let y = 20; y < 340; y += 4) {
        const i = (y * 640 + x) * 4;
        for (let ch = 0; ch < 3; ch++) maxDiff = Math.max(maxDiff, Math.abs(wipe[i + ch] - fade[i + ch]));
      }
      out.push({ id, kind: slide.kind, maxDiff });
    }
    const slides = (app.project.slides.map((s: Any) => [s.kind, s.items.map((h: string) => app.analysis.get(h)?.info.name)]));
    return { out, slides };
  });
  const res = got.out;
  console.log(JSON.stringify(res), JSON.stringify(got.slides));
  expect(res.some((r) => r.kind === "pair")).toBe(true);
  expect(res.some((r) => r.kind === "photo")).toBe(true);
  for (const r of res) expect(r.maxDiff, `${r.kind} ${r.id}`).toBeLessThan(24);
});
