// Depth spike on the bench page: downloads Depth Anything V2 Small (checksummed), builds the
// ONNX Runtime session on the WASM provider in the production build, and times an inference.
import { expect, test } from "@playwright/test";

test("depth model runs in the browser", async ({ page }) => {
  test.setTimeout(400_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#/bench");
  await page.getByRole("button", { name: "Depth (download + time)" }).click();
  await expect(page.locator("table").getByText(/depth inference, second run|^error/)).toBeVisible({ timeout: 360_000 });
  const rows = await page.locator("table tbody").innerText();
  console.log(rows);
  expect(rows).not.toMatch(/error:/);
  expect(rows).toMatch(/depth inference, second run/);
  expect(errors).toEqual([]);
});
