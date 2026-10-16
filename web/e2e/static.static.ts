import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import Papa from "papaparse";
import { replayAudit } from "../src/domain/auditReplay";

// Runs against `out/` on a plain static server (playwright.static.config.ts). Nothing is stubbed:
// there is no API, so any /api request or failed asset load is a defect, not a test double.
const parse = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;
const count = (page: Page, label: string) => page.locator(`dt:text-is("${label}") + dd`);
const row = (page: Page, text: string) => page.locator("#review-queue button").filter({ hasText: text });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

let apiCalls: string[];
let failed: string[];
test.beforeEach(async ({ page }) => {
  apiCalls = [];
  failed = [];
  page.on("request", (r) => void (new URL(r.url()).pathname.startsWith("/api/") && apiCalls.push(r.url())));
  page.on("response", (r) => void (r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`)));
  page.on("requestfailed", (r) => void failed.push(`failed ${r.failure()?.errorText} ${r.url()}`));
});
test.afterEach(() => {
  expect(apiCalls).toEqual([]);
  expect(failed).toEqual([]);
});

async function sampleToReview(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bring two exports into agreement." })).toBeVisible();
  await page.getByRole("button", { name: "Or explore with sample data" }).click();
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Suggest mappings with AI" })).toHaveCount(0);
  await expect(page.getByText("AI mapping suggestions aren't available in this hosted version.")).toBeVisible();
  for (const side of ["A", "B"]) {
    await page.locator(`#map-${side}-productId`).selectOption("c0");
    await page.locator(`#map-${side}-name`).selectOption("c1");
    await page.locator(`#map-${side}-quantity`).selectOption("c2");
  }
  await page.getByLabel("Both files use the same quantity unit").check();
  await page.getByRole("button", { name: "Confirm mappings" }).click();
  await expect(count(page, "Matched pairs")).toHaveText("2");
}

async function download(page: Page, name: string) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: `Download ${name}` }).click()]);
  expect(dl.suggestedFilename()).toBe(name);
  return readFile((await dl.path())!, "utf8");
}

test("canonical manual workflow on the static build: no AI offered, three exports that replay", async ({ page }) => {
  await sampleToReview(page);
  await expect(page.getByRole("button", { name: "Run AI suggestions" })).toHaveCount(0);
  await expect(page.getByText("Status: Unavailable in this hosted version")).toBeVisible();
  await expect(row(page, "Ceramic mug white")).toContainText("Quantity differs");

  await row(page, "Organic cotton tote natural").click();
  await page.getByRole("button", { name: /^Pair with Natural cotton shopping bag/ }).click();
  await expect(row(page, "Organic cotton tote natural")).toContainText("Manual match");

  await page.getByRole("button", { name: "Continue to export" }).click();
  await page.getByRole("button", { name: "Prepare export" }).click();
  const matches = await download(page, "matches.csv");
  const unresolved = await download(page, "unresolved.csv");
  const audit = JSON.parse(await download(page, "audit.json"));

  expect(parse(matches)).toHaveLength(3);
  expect(parse(matches).find((r) => r.left_product_id === "P03")?.delta_b_minus_a).toBe("-1");
  expect(parse(unresolved)).toHaveLength(3);
  expect(audit.modelRuns).toEqual([]);
  expect(audit.acceptedPairs.map((p: { method: string }) => p.method).sort()).toEqual(["exact_id", "exact_id", "manual"]);
  const replay = await replayAudit(audit);
  expect(replay.ok).toBe(true);
  if (replay.ok) {
    expect(replay.value.files["matches.csv"]).toBe(matches);
    expect(replay.value.files["unresolved.csv"]).toBe(unresolved);
  }
});

test("every stage fits 390px without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(await overflow(page)).toBe(0);
  await sampleToReview(page);
  expect(await overflow(page)).toBe(0);
  await page.getByRole("button", { name: "Continue to export" }).click();
  await page.getByRole("button", { name: "Prepare export" }).click();
  expect(await overflow(page)).toBe(0);
});

test("a refresh mid-workflow returns to a clean import, and an unknown path gets the 404 page", async ({ page }) => {
  await sampleToReview(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Bring two exports into agreement." })).toBeVisible();
  await expect(page.getByText("Valid CSV")).toHaveCount(0);
  const res = await page.request.get("/no-such-page.html");
  expect(res.status()).toBe(404);
});
