import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, page: Page, dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-dark-mode-"));
  app = await electron.launch({
    args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
});
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
test("author switches appearance to dark and back, theme applies across views", async () => {
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "创作导航" });
  await expect(nav.getByRole("button", { name: "创作", exact: true })).toBeVisible();
  await expect(page.locator(":root")).toHaveAttribute("data-theme", "light");
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("外观", { exact: true }).selectOption("dark");
  await expect(page.locator(":root")).toHaveAttribute("data-theme", "dark");
  await nav.getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.locator(".conversation-workspace")).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/dark-conversation-20261016.png" });
  await nav.getByRole("button", { name: "书架", exact: true }).click();
  await page.screenshot({ path: "docs/screenshots/dark-bookcase-20261016.png" });
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("外观", { exact: true }).selectOption("light");
  await expect(page.locator(":root")).toHaveAttribute("data-theme", "light");
});
