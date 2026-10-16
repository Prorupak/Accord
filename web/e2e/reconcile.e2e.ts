import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import Papa from "papaparse";
import { replayAudit } from "../src/domain/auditReplay";
import { canonicalSuggestResponse, errorEnvelope } from "./canonicalModel";

const parse = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;
const count = (page: Page, label: string) => page.locator(`dt:text-is("${label}") + dd`);
const row = (page: Page, text: string) => page.locator("#review-queue button").filter({ hasText: text });

test.beforeEach(async ({ page }) => {
  // Registered first, so it only handles API calls no test stubbed: nothing reaches a real server.
  await page.route("**/api/**", (route) => route.abort());
});

// Export shows zero-padded counts; the screen-reader text carries the plain number.
async function expectExportCounts(page: Page, matched: string, a: string, b: string) {
  for (const [label, n] of [["Matched pairs", matched], ["Unresolved in A", a], ["Unresolved in B", b]])
    await expect(count(page, label).locator(".sr-only")).toHaveText(n);
}

async function sampleToReview(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bring two exports into agreement." })).toBeVisible();
  await page.getByRole("button", { name: "Or explore with sample data" }).click();
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
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

test("canonical reconciliation with a deterministic AI test double, exported and replayed", async ({ page }) => {
  await page.route("**/api/suggest", async (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: canonicalSuggestResponse(route.request().postData()!) }),
  );
  await sampleToReview(page);

  await expect(row(page, "Stainless steel flask 750ml")).toContainText("Matched by product ID");
  const p03 = row(page, "Ceramic mug white");
  await expect(p03).toContainText("Matched by product ID");
  await expect(p03).toContainText("Quantity differs");
  await expect(p03).toContainText(/-1$/);
  await p03.click();
  await expect(page.locator("#detail-title")).toHaveText("Matched by product ID");
  await expect(page.getByText("Both records carry the unique product ID P03.")).toBeVisible();

  await page.getByRole("button", { name: "Run AI suggestions" }).click();
  await expect(page.getByText("Status: Complete")).toBeVisible();
  await expect(page.getByText("Last request: test-double, deterministic-canonical, result valid.")).toBeVisible();
  await expect(count(page, "Needs review")).toHaveText("1");

  await row(page, "Organic cotton tote natural").click();
  await expect(page.getByText("Suggested interpretation:")).toBeVisible();
  await page.getByRole("button", { name: "Accept pair" }).click();
  await expect(count(page, "Matched pairs")).toHaveText("3");
  await expect(row(page, "Travel cup blue")).toContainText("Unresolved: ambiguous");

  await page.getByRole("button", { name: "Continue to export" }).click();
  await expectExportCounts(page, "3", "1", "2");
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
  await page.getByRole("button", { name: "03 Review" }).click();
  await row(page, "Organic cotton tote natural").click();
  await page.getByRole("button", { name: "Undo match" }).click();
  await page.getByRole("button", { name: "04 Export" }).click();
  await expect(page.getByRole("link", { name: /^Download/ })).toHaveCount(0);
  await expectExportCounts(page, "2", "2", "3");
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

  await row(page, "Organic cotton tote natural").click();
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
  await page.getByRole("button", { name: "Or explore with sample data" }).click();
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  expect(await overflow()).toBe(0);
  await sampleToReview(page);
  await row(page, "Travel cup blue").click();
  expect(await overflow()).toBe(0);
  const pick = page.getByRole("button", { name: /^Pair with Travel tumbler blue 500ml/ });
  expect((await pick.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await page.getByRole("button", { name: "Continue to export" }).click();
  await page.getByRole("button", { name: "Prepare export" }).click();
  expect(await overflow()).toBe(0);
});

test("an identifier conflict is blocked with its recovery, never bypassed", async ({ page }) => {
  await page.goto("/");
  const csv = (name: string, text: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
  await page.locator("#source-A-file").setInputFiles(csv("a.csv", "sku,item,qty\nD1,Blue mug,1\n,Green mug,3\n"));
  await page.locator("#source-B-file").setInputFiles(csv("b.csv", "code,desc,stock\nD1,Blue mug,1\nD1,Blue mug copy,1\n,Green mug,3\n"));
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  for (const side of ["A", "B"]) {
    await page.locator(`#map-${side}-productId`).selectOption("c0");
    await page.locator(`#map-${side}-name`).selectOption("c1");
    await page.locator(`#map-${side}-quantity`).selectOption("c2");
  }
  await page.getByRole("button", { name: "Confirm mappings" }).click();
  await page.getByRole("button", { name: /^Identifier conflicts/ }).click();
  await row(page, "Blue mug").first().click();
  await expect(page.locator("#detail-title")).toHaveText("Identifier conflict");
  await expect(page.getByText("Accord does not pair around an identifier conflict.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept pair" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Pair with/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue to export" }).click();
  await expect(page.getByRole("button", { name: "Prepare export" })).toBeVisible();
});

test("Review shows queue and inspector side by side at 1440, as Records/Details panes at 1024 and 390", async ({ page }) => {
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const panes = page.getByRole("group", { name: "Show panel" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await sampleToReview(page);
  await expect(panes).toBeHidden();
  await expect(page.locator("#review-queue")).toBeVisible();
  await expect(page.locator("#detail-title")).toBeVisible();
  // The queue starts inside the first screen.
  expect((await page.locator("#review-queue").boundingBox())!.y).toBeLessThan(900);
  expect(await overflow()).toBe(0);

  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "Records", exact: true }).click();
    await expect(panes).toBeVisible();
    await expect(page.locator("#detail-title")).toBeHidden();
    await row(page, "Travel cup blue").click();
    await expect(page.locator("#detail-title")).toBeFocused();
    await expect(page.locator("#review-queue")).toBeHidden();
    await expect(page.getByRole("button", { name: /^Pair with Travel tumbler blue 500ml/ })).toBeVisible();
    expect(await overflow()).toBe(0);
  }
});

test("a long queue scrolls inside its pane without stretching the page below the footer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const csv = (name: string, header: string, label: string) => {
    const rows = Array.from({ length: 60 }, (_, i) => `${i % 3 ? "" : `P${i}`},${label} ${i},${i}`);
    return { name, mimeType: "text/csv", buffer: Buffer.from([header, ...rows].join("\n") + "\n") };
  };
  await page.locator("#source-A-file").setInputFiles(csv("a.csv", "sku,item,qty", "Thing"));
  await page.locator("#source-B-file").setInputFiles(csv("b.csv", "code,desc,stock", "Item"));
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  for (const side of ["A", "B"]) {
    await page.locator(`#map-${side}-productId`).selectOption("c0");
    await page.locator(`#map-${side}-name`).selectOption("c1");
    await page.locator(`#map-${side}-quantity`).selectOption("c2");
  }
  await page.getByLabel("Both files use the same quantity unit").check();
  await page.getByRole("button", { name: "Confirm mappings" }).click();
  await expect(row(page, "Thing 59")).toBeAttached();
  const belowFooter = await page
    .getByRole("button", { name: "Continue to export" })
    .evaluate((b) => document.documentElement.scrollHeight - (b.getBoundingClientRect().bottom + window.scrollY));
  expect(belowFooter).toBeLessThan(100);
});

test("Export lays out without page overflow at 1440, 1024 and 390, with 44px actions", async ({ page }) => {
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.setViewportSize({ width: 1440, height: 900 });
  await sampleToReview(page);
  await page.getByRole("button", { name: "Continue to export" }).click();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("link", { name: /^Download/ })).toHaveCount(0);
    expect(await overflow()).toBe(0);
    if (process.env.EXPORT_SHOTS) await page.screenshot({ path: `${process.env.EXPORT_SHOTS}/export-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "Prepare export" }).click();
  await expect(page.getByRole("link", { name: /^Download/ })).toHaveCount(3);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await overflow()).toBe(0);
    expect((await page.getByRole("button", { name: "Prepare again" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole("link", { name: "Download audit.json" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (process.env.EXPORT_SHOTS) await page.screenshot({ path: `${process.env.EXPORT_SHOTS}/export-${width}-prepared.png`, fullPage: true });
  }
});
