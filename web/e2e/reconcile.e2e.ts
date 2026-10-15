import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import Papa from "papaparse";
import { replayAudit } from "../src/domain/auditReplay";
import { canonicalSuggestResponse, errorEnvelope } from "./canonicalModel";

const parse = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;
const count = (page: Page, label: string) => page.locator(`dt:text-is("${label}") + dd`);
const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

test.beforeEach(async ({ page }) => {
  // Registered first, so it only handles API calls no test stubbed: nothing reaches a real server.
  await page.route("**/api/**", (route) => route.abort());
});

async function sampleToReview(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bring two exports into agreement." })).toBeVisible();
  await page.getByRole("button", { name: "Try sample data" }).click();
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  await page.getByRole("button", { name: "Continue to mapping" }).click();
  for (const side of ["A", "B"]) {
    await page.locator(`#map-${side}-productId`).selectOption("c0");
    await page.locator(`#map-${side}-name`).selectOption("c1");
    await page.locator(`#map-${side}-quantity`).selectOption("c2");
  }
  await page.getByLabel("Both quantity columns use the same unit").check();
  await page.getByRole("button", { name: "Confirm mappings" }).click();
  await expect(count(page, "Matched pairs")).toHaveText("2");
}

async function download(page: Page, name: string) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: `Download ${name}` }).click()]);
  expect(dl.suggestedFilename()).toBe(name);
  return readFile((await dl.path())!, "utf8");
}

test("canonical reconciliation with a deterministic AI test double, exported and replayed", async ({ page }) => {
  await page.route("**/api/suggest", async (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: canonicalSuggestResponse(route.request().postData()!) }),
  );
  await sampleToReview(page);

  await expect(row(page, "Stainless steel flask 750ml")).toContainText("Matched by product ID");
  const p03 = row(page, "Ceramic mug white");
  await expect(p03).toContainText("Matched by product ID");
  await expect(p03.getByRole("cell").nth(5)).toHaveText("-1");

  await page.getByRole("button", { name: "Run AI suggestions" }).click();
  await expect(page.getByText("Status: Complete")).toBeVisible();
  await expect(page.getByText("Last request: test-double, deterministic-canonical, result valid.")).toBeVisible();
  await expect(count(page, "Needs review")).toHaveText("1");

  await row(page, "Organic cotton tote natural").getByRole("button", { name: /^Details/ }).click();
  await expect(page.getByText("Suggested interpretation:")).toBeVisible();
  await page.getByRole("button", { name: "Accept pair" }).click();
  await expect(count(page, "Matched pairs")).toHaveText("3");
  await expect(row(page, "Travel cup blue")).toContainText("Unresolved: ambiguous");

  await page.getByRole("button", { name: "Continue to export" }).click();
  await expect(page.getByText("3 matched pairs. 1 unresolved record in A, 2 in B.")).toBeVisible();
  await page.getByRole("button", { name: "Prepare export" }).click();

  const matches = await download(page, "matches.csv");
  const unresolved = await download(page, "unresolved.csv");
  const audit = JSON.parse(await download(page, "audit.json"));

  expect(parse(matches)).toHaveLength(3);
  expect(parse(matches).find((r) => r.left_product_id === "P03")?.delta_b_minus_a).toBe("-1");
  expect(parse(unresolved).map((r) => r.source)).toEqual(["A", "B", "B"]);
  expect(audit.acceptedPairs).toHaveLength(3);
  expect(audit.modelRuns[0]).toMatchObject({ provider: "test-double", result: "valid" });
  const replay = await replayAudit(audit);
  expect(replay.ok).toBe(true);
  if (replay.ok) {
    expect(replay.value.files["matches.csv"]).toBe(matches);
    expect(replay.value.files["unresolved.csv"]).toBe(unresolved);
  }

  // Any edit invalidates the prepared files.
  await page.getByRole("button", { name: "3. Review" }).click();
  await row(page, "Organic cotton tote natural").getByRole("button", { name: /^Details/ }).click();
  await page.getByRole("button", { name: "Undo match" }).click();
  await page.getByRole("button", { name: "4. Export" }).click();
  await expect(page.getByRole("link", { name: /^Download/ })).toHaveCount(0);
  await expect(page.getByText("2 matched pairs. 2 unresolved records in A, 3 in B.")).toBeVisible();
});

test("AI provider failure leaves manual reconciliation and a consistent export", async ({ page }) => {
  await page.route("**/api/suggest", async (route) =>
    route.fulfill({ status: 502, contentType: "application/json", body: errorEnvelope("UPSTREAM_ERROR", route.request().postData()!) }),
  );
  await sampleToReview(page);
  await page.getByRole("button", { name: "Run AI suggestions" }).click();
  await expect(page.getByText("Status: Failed")).toBeVisible();
  await expect(page.getByText("The AI provider returned an error. (UPSTREAM_ERROR)", { exact: false })).toBeVisible();
  await expect(count(page, "Matched pairs")).toHaveText("2");

  await row(page, "Organic cotton tote natural").getByRole("button", { name: /^Details/ }).click();
  await page.getByRole("button", { name: /^Pair with Natural cotton shopping bag/ }).click();
  await expect(row(page, "Organic cotton tote natural")).toContainText("Manual match");

  await page.getByRole("button", { name: "Continue to export" }).click();
  await expect(page.getByText("AI analysis was incomplete (failed)")).toBeVisible();
  await page.getByRole("button", { name: "Prepare export" }).click();
  const audit = JSON.parse(await download(page, "audit.json"));
  expect(audit.analysis.status).toBe("failed");
  expect(audit.acceptedPairs.map((p: { method: string }) => p.method).sort()).toEqual(["exact_id", "exact_id", "manual"]);
  expect((await replayAudit(audit)).ok).toBe(true);
  expect(parse(await download(page, "unresolved.csv"))).toHaveLength(3);
});

test("every stage fits a 390px phone without horizontal page scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.goto("/");
  await page.getByRole("button", { name: "Try sample data" }).click();
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  expect(await overflow()).toBe(0);
  await sampleToReview(page);
  await row(page, "Travel cup blue").getByRole("button", { name: /^Details/ }).click();
  expect(await overflow()).toBe(0);
  const pick = page.getByRole("button", { name: /^Pair with Travel tumbler blue 500ml/ });
  expect((await pick.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await page.getByRole("button", { name: "Continue to export" }).click();
  await page.getByRole("button", { name: "Prepare export" }).click();
  expect(await overflow()).toBe(0);
});
