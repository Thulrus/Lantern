// Re-analysis from the analysis panel: the model stages run again for the show's photos and the
// panel walks back through them to "Analysis done".
import { expect, test } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "example_photos");

test("run analysis again", async ({ page }) => {
  test.skip(!existsSync(dir), "needs example_photos/");
  test.setTimeout(600_000);
  const photos = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).slice(0, 3).map((f) => join(dir, f));
  await page.goto("/");
  await page.locator('input[type="file"][multiple]').first().setInputFiles(photos);
  await page.waitForURL(/#\/make\//, { timeout: 120_000 });
  const panel = page.locator(".panel");
  await expect(panel.getByText("Analysing your photos")).toBeVisible();
  await expect(panel.getByText("Analysis done")).toBeVisible({ timeout: 300_000 });
  await panel.getByText("Run analysis again…").click();
  await panel.getByRole("button", { name: "Run again" }).click();
  await page.waitForFunction(() => { const d = (globalThis as any).lantern.pipeline().stages.find((x: { id: string }) => x.id === "depth"); return d.done < d.total; }, null, { timeout: 30_000 }); // eslint-disable-line
  await expect(panel.getByText("Analysis done")).toBeVisible({ timeout: 300_000 });
  const d = await page.evaluate(() => (globalThis as any).lantern.pipeline().stages.find((x: { id: string }) => x.id === "depth")); // eslint-disable-line
  expect(d.done).toBe(3);
  expect(d.errors).toBe(0);
});
