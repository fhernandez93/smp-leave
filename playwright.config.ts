import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    timezoneId: "Europe/Zurich",
    locale: "en-GB",
  },
  webServer: {
    command: "node test/e2e/server.ts",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "zurich", use: { ...devices["Desktop Chrome"] } },
    { name: "auckland", grep: /@tz/, use: { ...devices["Desktop Chrome"], timezoneId: "Pacific/Auckland" } },
    { name: "los-angeles", grep: /@tz/, use: { ...devices["Desktop Chrome"], timezoneId: "America/Los_Angeles" } },
    { name: "phone", grep: /@phone/, use: { ...devices["Pixel 7"] } },
  ],
});
