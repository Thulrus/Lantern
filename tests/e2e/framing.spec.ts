// Framing editor (spec §11.2): boxes stay reachable (inside the editor, grabbable when they
// overlap) and the edited framing is what the renderer shows (owner, 2026-11-15: the show
// ignored framing edits). Synthetic photos, so it runs without example_photos/.
import { expect, test, type Page } from "@playwright/test";
import { syntheticPhotos } from "./synthetic";

type Any = any; // eslint-disable-line
const SHOTS = process.env.FRAMING_SHOTS;

async function openSlide(page: Page, kind: string) {
  const i = await page.evaluate((k) => (globalThis as Any).lantern.project.slides.findIndex((s: Any) => s.kind === k), kind);
  expect(i).toBeGreaterThanOrEqual(0);
  await page.locator(".board .card").nth(i).click();
  const btn = page.getByRole("button", { name: "Edit framing" });
  if (await btn.count()) await btn.click();
  await expect(page.locator(".framing .stage")).toBeVisible();
  return page.evaluate((k) => (globalThis as Any).lantern.project.slides.find((s: Any) => s.kind === k).id, kind);
}
/** Page position of a camera-space point on the editor's stage. */
async function at(page: Page, u: number, v: number) {
  return page.evaluate(([u, v]) => {
    const el = document.querySelector(".framing .stage") as HTMLElement, r = el.getBoundingClientRect();
    const [sw, sh] = el.style.aspectRatio.split("/").map(Number);
    return { x: r.left + (u / sw + 0.5) * r.width, y: r.top + (v / sh + 0.5) * r.height };
  }, [u, v]);
}
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 }); await page.mouse.up();
}

test("framing edits are reachable and honoured by the renderer", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  const files = await syntheticPhotos(page, [["a1.jpg", 1600, 1200, 10], ["a2.jpg", 1600, 1200, 200], ["b1.jpg", 900, 1600, 100], ["b2.jpg", 900, 1600, 280], ["c1.jpg", 1600, 1200, 50]]);
  await page.locator('input[type="file"][multiple]').first().setInputFiles(files);
  await page.waitForURL(/#\/make\//, { timeout: 60_000 });
  await page.getByText("Make my show").click();
  await page.waitForURL(/#\/edit\//);
  await expect(page.locator(".board .card").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => (globalThis as Any).lanternPlayer, null, { timeout: 30_000 });

  const id = await openSlide(page, "photo");
  const ia = 4 / 3, aspect = 16 / 9;
  // Start and end on the same view, so the end box covers the start box completely.
  await page.evaluate((id) => {
    const app = (globalThis as Any).lantern, s = app.project.slides.find((x: Any) => x.id === id);
    const k = s.treatment.keys;
    app.setFraming(id, { keys: [{ ...k[0], t: 0, view: [0, 0, 0.5] }, { ...k[k.length - 1], t: 1, view: [0, 0, 0.5] }] });
  }, id);
  if (SHOTS) await page.locator(".framing").screenshot({ path: `${SHOTS}/framing-overlap.png` });
  // Select Start with its chip and pull its bottom-right corner out to the whole photo.
  await page.locator(".framing .chips button", { hasText: "Start" }).click();
  await dragTo(page, await at(page, (0.5 * aspect) / 2, 0.25), await at(page, 2, 1.5)); // past the editor: the pointer is captured, the frame stops at the whole photo
  // Then drag the End box's top-left corner in and move it to the top right.
  await page.locator(".framing .chips button", { hasText: "End" }).click();
  await dragTo(page, await at(page, -(0.5 * aspect) / 2, -0.25), await at(page, -(0.3 * aspect) / 2 + 0.05, -0.15));
  const endBox = await page.evaluate((id) => (globalThis as Any).lantern.project.slides.find((x: Any) => x.id === id).treatment.keys.at(-1).view, id);
  await dragTo(page, await at(page, endBox[0], endBox[1]), await at(page, endBox[0] + 1, endBox[1] - 1));
  if (SHOTS) await page.locator(".framing").screenshot({ path: `${SHOTS}/framing-edited.png` });

  const r = await page.evaluate((id) => {
    const app = (globalThis as Any).lantern, p = (globalThis as Any).lanternPlayer;
    const s = app.project.slides.find((x: Any) => x.id === id);
    const l = app.timeline.layers.find((x: Any) => x.id === id);
    const c = document.querySelector(".stage canvas") as HTMLCanvasElement;
    const f = (t: number) => p.renderer.frame(l, t, c.width, c.height).view;
    return { keys: s.treatment.keys.map((k: Any) => k.view), locked: !!s.locks.treatment, f0: f(l.t0), f1: f(l.t1), undo: app.undo.length };
  }, id);
  console.log(JSON.stringify(r));
  expect(r.locked).toBe(true);
  expect(r.keys[0][2]).toBeCloseTo(1, 2);              // start pulled out to the whole photo
  expect(r.f0[2]).toBeGreaterThan(0.99);                // ... and the renderer shows it
  const [ex, ey, es] = r.keys[1];
  expect(es).toBeLessThan(0.45);
  expect(ex + (es * aspect) / 2).toBeCloseTo(ia / 2, 3);    // end pushed into the top-right corner
  expect(ey - es / 2).toBeCloseTo(-0.5, 3);
  for (let j = 0; j < 3; j++) expect(Math.abs(r.f1[j] - r.keys[1][j])).toBeLessThan(0.01);
  // One undo step per drag: undo restores the previous end framing.
  await page.evaluate(() => (globalThis as Any).lantern.undoEdit());
  const back = await page.evaluate((id) => (globalThis as Any).lantern.project.slides.find((x: Any) => x.id === id).treatment.keys.at(-1).view, id);
  expect(back[2]).toBeCloseTo(es, 6);
  expect(back[0]).not.toBeCloseTo(ex, 3);

  // A pair: each photo has its own framing, and the renderer uses it.
  const pid = await openSlide(page, "pair");
  await page.locator(".framing .chips button", { hasText: "Right photo" }).click();
  await page.locator(".framing .chips button", { hasText: "End" }).click();
  const pv = await page.evaluate((pid) => { const app = (globalThis as Any).lantern; const s = app.project.slides.find((x: Any) => x.id === pid); return s.treatment.cells?.[1]?.at(-1)?.view ?? null; }, pid);
  expect(pv).toBeNull(); // nothing stored until the first edit
  await page.locator(".framing .pad").focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press("+");
  const pr = await page.evaluate((pid) => {
    const app = (globalThis as Any).lantern, p = (globalThis as Any).lanternPlayer;
    const s = app.project.slides.find((x: Any) => x.id === pid);
    const l = app.timeline.layers.find((x: Any) => x.id === pid).cells[1].slide;
    return { want: s.treatment.cells[1].at(-1).view, got: p.renderer.frame(l, l.t1, 300, 337).view, left: s.treatment.cells[0].length };
  }, pid);
  console.log(JSON.stringify(pr));
  expect(pr.left).toBe(2);
  for (let j = 0; j < 3; j++) expect(Math.abs(pr.got[j] - pr.want[j])).toBeLessThan(0.01);
  if (SHOTS) await page.locator(".framing").screenshot({ path: `${SHOTS}/framing-pair.png` });
});
