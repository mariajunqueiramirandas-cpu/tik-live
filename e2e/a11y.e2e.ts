import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Accessibility (ADR-0017): no serious or critical axe violations on the
 * public page and the main dashboard screens.
 */
async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
  expect(summary, `${label}\n${summary.join("\n")}`).toEqual([]);
}

test("landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".phone-canvas")).toHaveAttribute("data-ready", "true");
  await audit(page, "landing");
});

test("dashboard screens", async ({ page }) => {
  await page.goto("/app/new");
  await audit(page, "create a host");
  await page.getByLabel("Name").fill("A11y host");
  await page.getByRole("button", { name: "Create host" }).click();
  await expect(page).toHaveURL(/\/app\/hosts\/[^/]+$/);
  const host = page.url();
  await expect(page.getByText("is off air")).toBeVisible();
  await audit(page, "studio");
  for (const tab of ["character", "character?tab=voice", "character?tab=show", "safety", "setup", "analytics"]) {
    await page.goto(`${host}/${tab}`);
    await page.waitForLoadState("networkidle");
    await audit(page, tab);
  }
  for (const path of ["/app", "/app/billing", "/app/account"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await audit(page, path);
  }
});
