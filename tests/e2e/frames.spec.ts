// Frame dump for visual checks of the 3D treatments: imports the local example photos, waits for
// depth, forces a few depth treatments and saves frames of each (plus the depth map and matte)
// under test-results/frames/. Skipped when ./example_photos is missing. Not a pass/fail test
// beyond "it renders without errors": the frames are for a human (or agent) to look at.
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const photosDir = join(process.cwd(), "example_photos");
const out = join(process.cwd(), "test-results", "frames");
const TREATMENTS = (process.env.FRAMES_TREATMENTS ?? "arc,depthPush").split(",");
const PICK = Number(process.env.FRAMES_N ?? 8);
const TRANSITION = process.env.FRAMES_TRANSITION ?? "";

test("dump 3D frames", async ({ page }) => {
  test.skip(!existsSync(photosDir), "no example_photos folder");
  test.setTimeout(900_000);
  mkdirSync(out, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const photos = readdirSync(photosDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => join(photosDir, f));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator('input[type="file"][multiple]').first().setInputFiles(photos);
  await page.waitForURL(/#\/make\//, { timeout: 120_000 });
  await page.locator("button.style", { hasText: "Cinematic" }).click();
  await page.getByText("Make my show").click();
  await page.waitForURL(/#\/edit\//);
  await expect(page.locator(".board .card").first()).toBeVisible({ timeout: 30_000 });
  // FRAMES_FILL=1: generative fill behind people on, and wait for the fill stage too.
  page.on("console", (m) => { if (m.text().startsWith("[fill]")) console.log(m.text()); });   // reasons and face boxes of rejected fills
  if (process.env.FRAMES_FILL) await page.evaluate(() => (globalThis as any).lantern.setGenerativeFill("all")); // eslint-disable-line
  await page.waitForFunction(() => /depth done/.test(document.body.innerText), null, { timeout: 600_000 });
  if (process.env.FRAMES_FILL) {
    await page.waitForFunction(() => (globalThis as any).lantern.queue?.queued === 0, null, { timeout: 600_000 }); // eslint-disable-line
    const st = await page.evaluate(() => [...(globalThis as any).lantern.stageStatus].filter(([k]: [string]) => k.endsWith("|fill")).map(([k, v]: [string, string]) => `${k.slice(0, 8)} ${v}`)); // eslint-disable-line
    console.log("fill stages:", st.join(", "));
  }
  await page.waitForTimeout(1500);
  const frames = await page.evaluate(async ({ treatments, pick, transition }) => {
    type Any = any; // eslint-disable-line
    const app = (globalThis as Any).lantern;
    const slides = app.project.slides.filter((s: Any) => s.kind === "photo" && app.analysis.get(s.items[0])?.depth).slice(0, pick);
    const res: { name: string; data: string }[] = [];
    const canvas = document.querySelector(".stage canvas") as HTMLCanvasElement;
    const p = (globalThis as Any).lanternPlayer;
    canvas.width = 1280; canvas.height = 720;
    const info: string[] = [];
    for (const [i, s0] of slides.entries()) {
      const m = app.analysis.get(s0.items[0]);
      info.push(`${i} ${m.info.name} ${m.info.w}x${m.info.h} sep ${m.depth.sep.toFixed(3)} pivot ${m.depth.pivot.toFixed(2)} q ${m.depth.quality.toFixed(2)} faces ${(m.faces ?? []).length}${m.depth.matte ? ` matte ${JSON.stringify(m.depth.matte)}` : ""}`);
      for (const id of treatments) {
        const s = app.project.slides.find((x: Any) => x.id === s0.id);
        app.setTreatment(s, id, 1, 1);
        if (transition) {
          app.edit((p: Any) => { const k = p.slides.findIndex((x: Any) => x.id === s0.id); if (p.slides[k + 1]) p.slides[k + 1].transitionIn = { type: transition, dur: 1.5 }; });
          const tl2 = app.timeline, l2 = tl2.layers.find((x: Any) => x.id === s0.id), nx = tl2.layers[tl2.layers.indexOf(l2) + 1];
          if (nx?.enter) for (const q of [0.25, 0.5, 0.75]) {
            const t = nx.enter.t0 + (nx.enter.t1 - nx.enter.t0) * q;
            await p.assets.ensure(tl2, t);
            canvas.width = 1280; canvas.height = 720;
            p.renderer.draw(tl2, t);
            const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
            const b64 = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(blob); });
            res.push({ name: `${String(i).padStart(2, "0")}-${transition}-${q}.jpg`, data: b64 });
            if (q === 0.5) {
              p.renderer.debug = 1; p.renderer.draw(tl2, t); p.renderer.debug = 0;
              const blob2: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
              const b642 = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(blob2); });
              res.push({ name: `${String(i).padStart(2, "0")}-${transition}-depthB.jpg`, data: b642 });
            }
          }
        }
        const tl = app.timeline;
        const l = tl.layers.find((x: Any) => x.id === s0.id);
        const next = tl.layers[tl.layers.indexOf(l) + 1];
        const end = next?.enter && next.enter.type !== "cut" ? Math.min(l.t1, next.enter.t0) : l.t1;
        const start = l.enter && l.enter.type !== "cut" ? Math.min(end, l.enter.t1) : l.t0;
        for (const x of [0, 0.5, 1]) {
          const t = start + (end - start) * x;
          await p.assets.ensure(tl, t);
          canvas.width = 1280; canvas.height = 720;
          p.renderer.draw(tl, t);
          const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
          const b64 = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(blob); });
          res.push({ name: `${String(i).padStart(2, "0")}-${id}-${x}.jpg`, data: b64 });
        }
      }
      // The depth map (and matte / plate when present) from OPFS.
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("m")).getDirectoryHandle(s0.items[0]);
      const files: string[] = [];
      for await (const k of (dir as Any).keys()) files.push(k);
      info.push(`   files: ${files.join(", ")}`);
      const u16 = async (name: string) => {
        const f = await (await dir.getFileHandle(name)).getFile();
        const buf = await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        const dv = new DataView(buf); const w = dv.getUint16(4, true), h = dv.getUint16(6, true);
        return { w, h, a: new Uint16Array(buf.slice(8)) };
      };
      const show = async (name: string, w: number, h: number, px: (i: number) => number) => {
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const ctx = c.getContext("2d")!, im = ctx.createImageData(w, h);
        for (let k = 0; k < w * h; k++) { const v = px(k); im.data[k * 4] = v; im.data[k * 4 + 1] = v; im.data[k * 4 + 2] = v; im.data[k * 4 + 3] = 255; }
        ctx.putImageData(im, 0, 0);
        res.push({ name: `${String(i).padStart(2, "0")}-${name}.png`, data: c.toDataURL("image/png").split(",")[1] });
      };
      if (files.includes("depth.u16.gz")) { const d = await u16("depth.u16.gz"); await show("depth", d.w, d.h, (k) => d.a[k] >> 8); }
      if (files.includes("matte.u8.gz")) {
        const f = await (await dir.getFileHandle("matte.u8.gz")).getFile();
        const buf = await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        const dv = new DataView(buf); const w = dv.getUint16(4, true), h = dv.getUint16(6, true); const a = new Uint8Array(buf.slice(8));
        await show("matte", w, h, (k) => a[k]);
      }
      if (files.includes("people.u8.gz")) {
        const f = await (await dir.getFileHandle("people.u8.gz")).getFile();
        const buf = await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        const dv = new DataView(buf); const w = dv.getUint16(4, true), h = dv.getUint16(6, true); const a = new Uint8Array(buf.slice(8));
        await show("people", w, h, (k) => a[k]);
      }
      for (const pf of ["plate.webp", "plategen.webp", "plategen.rejected.webp"]) if (files.includes(pf)) {
        const f = await (await dir.getFileHandle(pf)).getFile();
        const b64 = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(f); });
        res.push({ name: `${String(i).padStart(2, "0")}-${pf}`, data: b64 });
      }
      if (files.includes("platedepth.u16.gz")) { const d = await u16("platedepth.u16.gz"); await show("platedepth", d.w, d.h, (k) => d.a[k] >> 8); }
    }
    return { res, info };
  }, { treatments: TREATMENTS, pick: PICK, transition: TRANSITION });
  for (const f of frames.res) writeFileSync(join(out, f.name), Buffer.from(f.data, "base64"));
  writeFileSync(join(out, "info.txt"), frames.info.join("\n") + "\n");
  console.log(frames.info.join("\n"));
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
