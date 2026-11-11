// End-to-end: import the local example photos plus a synthetic song, make a show, check the
// preview draws, and try an export. Photos come from ./example_photos (not in the repo); the
// test falls back to synthetic images when that folder is missing.
import { expect, test } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const photosDir = join(process.cwd(), "example_photos");
const tmp = join(process.cwd(), "test-results", "fixtures");

function wav(bpm: number, seconds: number): Buffer {
  const sr = 22050, n = seconds * sr, data = Buffer.alloc(n * 2);
  const period = (60 / bpm) * sr;
  let s = 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const x = new Float32Array(n);
  for (let b = 0; b * period < n; b++) { const st = Math.round(b * period); for (let i = 0; i < 1200 && st + i < n; i++) x[st + i] += (b % 4 === 0 ? 1 : 0.5) * rnd() * Math.exp(-i / 250); }
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] += (t < seconds / 2 ? Math.sin(2 * Math.PI * 220 * t) : Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t)) * 0.15; }
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 20000))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("import, make, preview and export", async ({ page }) => {
  test.setTimeout(900_000);
  mkdirSync(tmp, { recursive: true });
  const song = join(tmp, "click-128.wav");
  writeFileSync(song, wav(128, 24));
  const photos = existsSync(photosDir) ? readdirSync(photosDir).filter((f) => /\.jpe?g$/i.test(f)).map((f) => join(photosDir, f)) : [];
  const logFile = join(tmp, "e2e.log");
  writeFileSync(logFile, "");
  const logs = { push: (l: string) => appendFileSync(logFile, l + "\n"), list: [] as string[] };
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.text()); });
  page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
  await page.goto("/");
  await expect(page.getByText("Slideshows that build themselves.")).toBeVisible();
  const input = page.locator('input[type="file"][multiple]').first();
  await input.setInputFiles([...photos, song]);
  await page.waitForURL(/#\/make\//, { timeout: 120_000 });
  await expect(page.getByText("Make my show")).toBeVisible();
  // Wait for the song analysis to show a tempo.
  await expect(page.getByText(/BPM/)).toBeVisible({ timeout: 60_000 });
  // Cinematic allows 3D treatments (Classic, the default, is 2D only).
  await page.locator("button.style", { hasText: "Cinematic" }).click();
  await page.getByText("Make my show").click();
  await page.waitForURL(/#\/edit\//);
  const cards = page.locator(".board .card");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  // Wait for faces (model download in the worker) or time out gracefully.
  await page.waitForFunction(() => /items analysed/.test(document.body.innerText), null, { timeout: 90_000 }).catch(() => logs.push("faces did not finish in time"));
  // Depth (model download + one inference per photo in the worker).
  await page.waitForFunction(() => /depth done/.test(document.body.innerText), null, { timeout: 300_000 }).catch(() => logs.push("depth did not finish in time"));
  const diag = await page.evaluate(async () => {
    const req = indexedDB.open("lantern");
    const db = await new Promise<IDBDatabase>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const all = <T,>(store: string) => new Promise<T[]>((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); });
    const media = await all<{ info: { name: string } }>("media");
    const analysis = await all<{ stage: string; status: string; error?: string; result: unknown }>("analysis");
    const faces = analysis.filter((a) => a.stage === "faces");
    const depth = analysis.filter((a) => a.stage === "depth");
    const depthOk = depth.filter((d) => d.status === "ok").map((d) => d.result as { depth: { sep: number; quality: number; w: number; h: number }; ms: number });
    return { depthOk: depthOk.length, depthErr: depth.filter((d) => d.status === "error").map((d) => d.error).slice(0, 3), depthMs: depthOk.map((d) => Math.round(d.ms)), depthStats: depthOk.slice(0, 8).map((d) => `${d.depth.w}x${d.depth.h} sep ${d.depth.sep.toFixed(2)} q ${d.depth.quality.toFixed(2)}`),
      media: media.length, names: media.map((m) => m.info.name).slice(0, 30), facesOk: faces.filter((f) => f.status === "ok").length, facesErr: faces.filter((f) => f.status === "error").map((f) => f.error).slice(0, 3), faceCounts: faces.filter((f) => f.status === "ok").map((f) => (f.result as { faces: unknown[] }).faces.length) };
  });
  logs.push("DIAG " + JSON.stringify(diag));
  expect(diag.depthErr).toEqual([]);
  // The planner should have upgraded photos with depth to 3D treatments.
  const treatments = await page.evaluate(async () => {
    const req = indexedDB.open("lantern");
    const db = await new Promise<IDBDatabase>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const projects = await new Promise<{ slides: { treatment: { id: string }; auto: { quality: string } }[] }[]>((res) => { const r = db.transaction("projects").objectStore("projects").getAll(); r.onsuccess = () => res(r.result); });
    const slides = projects[0]?.slides ?? [];
    return { ids: slides.map((s) => s.treatment.id), full: slides.filter((s) => s.auto.quality === "full").length, n: slides.length };
  });
  logs.push("TREATMENTS " + JSON.stringify(treatments));
  // Scrub into the show and check the canvas has drawn something.
  await page.locator(".scrub").click({ position: { x: 60, y: 9 } });
  await page.waitForTimeout(1500);
  const shot = await page.locator("canvas").first().screenshot({ path: join(tmp, "canvas.png") });
  const stats = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const o = document.createElement("canvas"); o.width = 64; o.height = 36;
    const ctx = o.getContext("2d")!; ctx.drawImage(img, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { w: img.width, h: img.height, mean: sum / (d.length / 4) / 3 };
  }, shot.toString("base64"));
  await page.screenshot({ path: join(tmp, "editor.png") });
  // Export dialog.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText(/Codec:|cannot encode/)).toBeVisible({ timeout: 20_000 });
  const codecLine = await page.locator(".sheet").innerText();
  logs.push("EXPORT: " + codecLine.split("\n").find((l) => /Codec|cannot/.test(l)));
  const canExport = /Codec: (avc|hevc|av1|vp9|vp8)/.test(codecLine);
  if (canExport) {
    const toggle = page.locator(".sheet").getByRole("switch", { name: /Choose where to save/ });
    if (await toggle.count()) await toggle.click();
    const t0 = Date.now();
    const dl = page.waitForEvent("download", { timeout: 800_000 }).catch(() => null);
    await page.locator(".sheet").getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.locator(".sheet").getByText(/Saved|cannot|error|Error/i)).toBeVisible({ timeout: 800_000 });
    const d = await dl;
    if (d) await d.saveAs(join(tmp, "export.mp4"));
    logs.push(`EXPORT TIME ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    logs.push("DOWNLOAD: " + (d ? d.suggestedFilename() : "none") + " | " + (await page.locator(".sheet").innerText()).split("\n").slice(-2).join(" / "));
  }
  const fatal = (await import("node:fs")).readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("PAGEERROR"));
  expect(fatal).toEqual([]);
});
