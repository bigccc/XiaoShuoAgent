import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

let app: ElectronApplication, page: Page, dir: string, server: Server, calls: string[];
test.beforeEach(async () => {
  calls = [];
  server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw), phase = body.messages[0].content;
    calls.push(phase);
    const output = phase.includes("连续写作·规划") ? { plan: "收信后前往书店。", majorChange: false, reason: "" }
      : phase.includes("连续写作·生成") ? { title: "雨夜", content: "雨落在书店门口。林舟收好来信，等待旧友按约前来。".repeat(5), majorChange: false, reason: "" }
      : { issues: [], majorChange: false, reason: "" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  dir = await mkdtemp(join(tmpdir(), "novel-billing-ui-"));
  app = await electron.launch({ executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE, args: [process.env.NOVEL_PACKAGED_EXECUTABLE ? "" : "out/main/index.js", "--use-mock-keychain"].filter(Boolean), env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir } });
  page = await app.firstWindow(); await page.waitForLoadState();
});
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});
async function fixture(priced = true) {
  await page.evaluate(async ({ url, priced }) => {
    await window.novel.invoke({ type: "project.create", title: "金额预算验收", chapterWords: 100 });
    await window.novel.invoke({ type: "profile.save", name: "受控模型", baseUrl: url, model: "fixture", purpose: "writing", ...(priced ? { pricing: { currency: "CNY" as const, input: 1, output: 2 } } : {}) });
  }, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, priced });
  await page.getByRole("button", { name: "打开 金额预算验收", exact: true }).click();
}
async function start() {
  await page.getByLabel("创作消息").fill("写完前一章");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认本次 AI 花费" });
  await expect(dialog).toBeVisible();
  return dialog;
}
test("unpriced models show explicit price guidance and cannot send requests", async () => {
  await fixture(false);
  const dialog = await start();
  await expect(dialog).toContainText("受控模型");
  await expect(dialog).toContainText("免费模型请明确填写 0");
  await expect(dialog.getByRole("button", { name: "按此预算开始" })).toBeDisabled();
  expect(calls).toHaveLength(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /受控模型/ }).first().click();
  await expect(page.getByLabel("输入单价（元／百万 Token）", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("输出单价（元／百万 Token）", { exact: true })).toHaveValue("");
});
test("cost approval cancellation preserves a zero-request operation", async () => {
  await fixture(); const dialog = await start();
  await expect(dialog).toContainText("预计花费：¥");
  expect(Number(await dialog.getByLabel("本次预算（元）").inputValue())).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(calls).toHaveLength(0);
  expect((await page.evaluate(() => window.novel.snapshot())).writingJobs ?? []).toHaveLength(0);
});
test("zero money pauses before network and an explicit raised budget resumes the same job", async () => {
  await fixture(); const dialog = await start();
  await dialog.getByLabel("本次预算（元）").fill("0.00");
  await dialog.getByRole("button", { name: "按此预算开始" }).click();
  const card = page.getByRole("region", { name: "连续写作任务" });
  await expect(card).toContainText("金额预算");
  await expect(card.getByRole("button", { name: "查看费用并继续", exact: true })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.screenshot({ path: "test-results/billing-paused.png" });
  const before = await page.evaluate(() => window.novel.snapshot());
  await card.getByRole("button", { name: "查看费用并继续", exact: true }).click();
  const resume = page.getByRole("dialog", { name: "确认本次 AI 花费" });
  await resume.getByLabel("本次预算（元）").fill("10.00");
  await resume.getByRole("button", { name: "按此预算开始" }).click();
  await expect(card).toContainText("任务已完成", { timeout: 30000 });
  const after = await page.evaluate(() => window.novel.snapshot());
  expect(after.writingJobs).toHaveLength(1);
  expect(after.writingJobs![0].id).toBe(before.writingJobs![0].id);
  expect(after.chapters).toHaveLength(1);
  expect(calls.filter(phase => phase.includes("连续写作·生成"))).toHaveLength(1);
  expect(calls.filter(phase => phase.includes("连续写作·检查"))).toHaveLength(1);
  const summary = await page.evaluate(id => window.novel.billingSummary(id), after.writingJobs![0].id);
  expect(summary.budgetMicros).toBe(10_000_000);
  expect(summary.spentMicros).toBeGreaterThan(0);
  await expect(card.getByLabel("任务费用估算")).toContainText("累计估算 ¥0.0012");
  await expect(card.getByLabel("任务费用估算")).toContainText("剩余预算 ¥9.9988");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/billing-completed.png" });
});
