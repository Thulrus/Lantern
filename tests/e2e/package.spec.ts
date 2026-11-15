// .lantern project files: save a show, open it in a fresh browser profile (empty storage) and get
// the same show back, with its edits and analysis and without re-running the basics.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { syntheticPhotos } from "./synthetic";

test("save a project file and open it in a fresh profile", async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  // No save picker: the package downloads, which Playwright can catch.
  await page.addInitScript(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  await page.goto("/");
  const files = await syntheticPhotos(page, [["a1.jpg", 1600, 900, 10], ["a2.jpg", 1600, 900, 200], ["a3.jpg", 1600, 900, 120], ["b1.jpg", 1200, 1200, 50]]);
  await page.locator('input[type="file"][multiple]').first().setInputFiles(files);
  await page.waitForURL(/#\/make\//, { timeout: 60_000 });
  await page.getByText("Make my show").click();
  await page.waitForURL(/#\/edit\//);
  await expect(page.locator(".board .card").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("input.title").fill("Packaged show");
  await page.locator("input.title").press("Enter");
  // An edit that the planner would not reproduce: the last slide's transition.
  const before = await page.evaluate(() => {
    type Any = any; // eslint-disable-line
    const app = (globalThis as Any).lantern;
    app.edit((p: Any) => { p.slides[p.slides.length - 1].transitionIn = { type: "dipWhite", dur: 0.9 }; });
    return { slides: app.project.slides.map((s: Any) => s.items.join("+")), last: app.project.slides.at(-1).transitionIn };
  });

  await page.getByRole("button", { name: "Save file" }).click();
  const dl = page.waitForEvent("download");
  await page.locator(".sheet").getByRole("button", { name: "Save project file" }).click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe("Packaged show.lantern");
  const path = await download.path();
  await expect(page.getByText(/Saved Packaged show\.lantern/)).toBeVisible();

  const ctx = await browser.newContext({ baseURL });
  const p2 = await ctx.newPage();
  await p2.goto("/");
  await expect(p2.getByText("Recent shows")).toHaveCount(0);
  await p2.locator(`input[type="file"][accept=".lantern"]`).setInputFiles({ name: "Packaged show.lantern", mimeType: "application/zip", buffer: readFileSync(path) });
  await p2.waitForURL(/#\/edit\//, { timeout: 60_000 });
  await expect(p2.locator(".board .card").first()).toBeVisible({ timeout: 30_000 });
  await expect(p2.locator("input.title")).toHaveValue("Packaged show");
  const after = await p2.evaluate(() => {
    type Any = any; // eslint-disable-line
    const app = (globalThis as Any).lantern;
    return {
      slides: app.project.slides.map((s: Any) => s.items.join("+")), last: app.project.slides.at(-1).transitionIn,
      basics: app.project.media.filter((h: string) => app.analysis.get(h)?.basics).length, media: app.project.media.length,
      originals: app.project.media.filter((h: string) => app.records.get(h)?.hasOriginal).length,
    };
  });
  expect(after.slides).toEqual(before.slides);
  expect(after.last).toEqual(before.last);
  expect(after.basics).toBe(after.media);
  expect(after.originals).toBe(after.media);
  await ctx.close();
});
