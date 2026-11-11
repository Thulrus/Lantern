import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  use: { baseURL: "http://localhost:4173", headless: true },
  webServer: { command: "npm run build && npm run preview -- --port 4173", port: 4173, reuseExistingServer: true },
  projects: [{ name: "chromium", use: { browserName: "chromium", launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } } }],
});
