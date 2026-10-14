import { expect, type Page } from "@playwright/test";

async function reached(page: Page, name: string) {
  const target = page.getByRole("button", { name, exact: true });
  await expect.poll(async () => await target.isVisible() || await page.getByRole("dialog").isVisible() || await page.locator(".save-state.danger").isVisible()).toBe(true);
  return await target.isVisible() && !await page.getByRole("dialog").isVisible();
}

// Legacy workflow regressions still exercise the full edit/review machinery,
// through the new author navigation and explicitly opened specialist controls.
export async function navigateAuthor(page: Page, name: string) {
  // After resolving a save dialog, React still needs to commit the queued
  // destination. Observe that render before deciding which context tabs exist.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const story: Record<string, string> = { "辅助工具": "作品信息", "创意与风格": "作品信息", "人物与世界": "人物与世界", "故事规划": "故事规划", "素材库": "素材库" };
  const reader: Record<string, string> = { "正文与版本": "正文与版本", "一致性检查": "检查问题", "任务与审阅": "待审稿与记录" };
  const nav = page.getByRole("navigation", { name: "创作导航" });
  if (story[name]) {
    if (name !== "素材库") await nav.getByRole("button", { name: "故事资料", exact: true }).waitFor();
    if (await nav.getByRole("button", { name: "故事资料", exact: true }).count()) {
      if (!await page.locator(".context-tabs").getByRole("button", { name: story[name], exact: true }).isVisible()) {
        await nav.getByRole("button", { name: "故事资料", exact: true }).click();
        if (!await reached(page, "作品信息")) return;
      }
      await page.getByRole("button", { name: story[name], exact: true }).click();
    } else {
      await nav.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "素材库", exact: true }).click();
    }
  } else if (reader[name]) {
    if (name !== "任务与审阅") await nav.getByRole("button", { name: "看稿", exact: true }).waitFor();
    if (await nav.getByRole("button", { name: "看稿", exact: true }).count()) {
      if (!await page.locator(".context-tabs").getByRole("button", { name: reader[name], exact: true }).isVisible()) {
        await nav.getByRole("button", { name: "看稿", exact: true }).click();
        if (!await reached(page, "阅读正文")) return;
      }
      await page.getByRole("button", { name: reader[name], exact: true }).click();
    } else {
      await nav.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "任务记录", exact: true }).click();
    }
  } else {
    const renamed: Record<string, string> = { "模型设置": "设置", "创作对话": "创作", "阅读与审阅": "看稿", "导出与备份": "导出" };
    await page.getByRole("button", { name: renamed[name] ?? name, exact: true }).click();
  }
  if (await page.getByRole("dialog").isVisible()) return;
  if (name === "创作对话") await expect(page.getByRole("region", { name: "对话创作工作区" })).toBeVisible();
  await openLegacyOperations(page);
}

export async function openLegacyOperations(page: Page) {
  const tools = page.locator(".workspace-tools");
  if (await tools.count()) {
    if (await tools.getAttribute("open") === null) await tools.locator(":scope > summary").click();
    const advanced = tools.locator(".ai-advanced");
    if (await advanced.count() && await advanced.getAttribute("open") === null) await advanced.locator(":scope > summary").click();
  }
}

export async function viewAuthorStage(page: Page, stage: string) {
  const detail = page.locator(".stage-documents");
  if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
  await detail.getByRole("button", { name: stage, exact: true }).click();
}

export async function customConnection(page: Page) {
  await page.getByLabel("服务商").selectOption("custom");
}
