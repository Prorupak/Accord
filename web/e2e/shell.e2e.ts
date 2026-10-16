import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
});

const stages = (page: Page) => page.getByRole("navigation", { name: "Workflow" }).getByRole("button");
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function toReview(page: Page) {
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
  await expect(page.getByRole("heading", { level: 1, name: "Review the proposed matches." })).toBeVisible();
}

test("at 390px every stage stays visible and the page never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(stages(page)).toHaveCount(4);
  for (const b of await stages(page).all()) await expect(b).toBeInViewport();
  expect(await noHorizontalScroll(page)).toBe(true);
  await toReview(page);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByRole("button", { name: "04 Export" }).click();
  expect(await noHorizontalScroll(page)).toBe(true);
  await expect(page.getByRole("button", { name: "Start over" })).toBeInViewport();
});

test("stages are reachable and operable from the keyboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Or explore with sample data" }).click();
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  await page.getByRole("button", { name: "01 Import" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "02 Mapping" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Understand your columns." })).toBeVisible();
  await expect(page.getByRole("button", { name: "02 Mapping" })).toHaveAttribute("aria-current", "step");
});

test("Start over asks first; dismissing keeps the work, accepting resets", async ({ page }) => {
  await page.goto("/");
  await toReview(page);
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByRole("button", { name: "03 Review" })).toHaveAttribute("aria-current", "step");

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bring two exports into agreement." })).toBeVisible();
  await expect(page.getByRole("button", { name: "02 Mapping" })).toBeDisabled();
});

test("Mapping panels sit side by side at 1024 and stack at 390 without sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Or explore with sample data" }).click();
  await expect(page.getByText("Valid CSV")).toHaveCount(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const panelA = page.getByRole("region", { name: "Source A" });
  const panelB = page.getByRole("region", { name: "Source B" });
  const [a, b] = [await panelA.boundingBox(), await panelB.boundingBox()];
  expect(b!.x).toBeGreaterThan(a!.x + a!.width - 2);
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  const [a2, b2] = [await panelA.boundingBox(), await panelB.boundingBox()];
  expect(b2!.y).toBeGreaterThanOrEqual(a2!.y + a2!.height - 2);
  expect(await noHorizontalScroll(page)).toBe(true);
  const confirm = page.getByRole("button", { name: "Confirm mappings" });
  await confirm.scrollIntoViewIfNeeded();
  await expect(confirm).toBeInViewport();
  expect((await confirm.boundingBox())!.width).toBeGreaterThan(300);
});
