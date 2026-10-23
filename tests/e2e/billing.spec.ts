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
}
for (const priced of [true,false]) test(`executes directly with ${priced ? 'known' : 'unknown'} prices and no cost gate`, async () => {
  await fixture(priced); await start();
  const card=page.getByRole("region",{name:"连续写作任务"});
  await expect(card).toContainText("任务已完成",{timeout:15000});
  await expect(page.getByRole("dialog",{name:"确认本次 AI 花费"})).toHaveCount(0);
  expect(calls.filter(p=>p.includes("连续写作·生成"))).toHaveLength(1);
  expect(calls.filter(p=>p.includes("连续写作·检查"))).toHaveLength(1);
  await expect(card.getByLabel("任务费用估算")).toContainText(priced?"累计估算":"费用未知");
  await expect(card).not.toContainText("剩余预算");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050,680));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/accounting-${priced?'priced':'unknown'}.png`});
});
