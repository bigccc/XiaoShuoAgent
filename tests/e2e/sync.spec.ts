import { navigateAuthor, customConnection, viewAuthorStage } from "./support/author-navigation";
import { _electron as electron, test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { normalizationReply } from "./support/sync-fixture";
let app: ElectronApplication, page: Page, dir: string, server: Server;
let turns = 0;
let normalizeMode: "normal" | "invalid" | "hold" = "normal";
async function launch() {
  app = await electron.launch({ args: process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"], executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE, env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir } });
  page = await app.firstWindow();
  await page.waitForLoadState();
}
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-sync-ui-")); turns = 0; normalizeMode = "normal";
  server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    let normalized = normalizationReply(body);
    if (normalized && normalizeMode === "hold") return;
    if (normalized && normalizeMode === "invalid") normalized = { ...normalized, blocks: [] };
    const stage = (["overview", "settings", "outline"] as const)[turns];
    if (!normalized) turns++;
    const blocks = stage === "overview"
      ? [{ kind: "field", field: "background", text: "整理师发现父亲留下的骗局。" }]
      : stage === "settings"
        ? [{ kind: "note", noteType: "character", title: "林舟", text: "怕黑的整理师。" }, { kind: "field", field: "style", text: "轻松悬疑" }, { kind: "note", noteType: "supplement", title: "写作提示", text: "父子靠行动和解。" }]
        : [{ kind: "note", noteType: "outline", title: "骗局调查", text: "收到包裹，调查骗局。" }];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(normalized ?? { message: "请确认这一阶段。", artifacts: [{ stage, blocks }] }) } }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await launch();
  await page.evaluate(async (baseUrl) => { await window.novel.invoke({ type: "profile.save", name: "同步验收", baseUrl, model: "fixture", purpose: "writing" }); }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
});
test.afterEach(async () => {
  await app?.close();
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  await rm(dir, { recursive: true, force: true });
});
async function overview() {
  await page.getByLabel("创作消息").fill("请准备概要");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("概要成果")).toHaveValue("整理师发现父亲留下的骗局。");
}
async function windowStage() { return (await page.evaluate(() => window.novel.snapshot())).projects[0].authoring!.activeStage; }
async function tools(view: string) { await navigateAuthor(page, view); }

test("generated stages update auxiliary fields, reverse rename retains identity and free drafts sync across restart", async () => {
  // Catches missing UI sync controls and missing stage-to-record projection.
  await expect(page.getByRole("button", { name: "立即同步", exact: true })).toBeVisible();
  await overview();
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  await tools("创意与风格");
  await expect(page.getByLabel("简介与背景", { exact: true })).toHaveValue("整理师发现父亲留下的骗局。");
  await navigateAuthor(page, "创作对话");
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("设定成果")).toHaveValue(/林舟/);
  const characterId = (await page.evaluate(() => window.novel.snapshot())).notes.find((n) => n.type === "character")!.id;
  await tools("人物与世界");
  await expect(page.getByRole("button", { name: /写作提示/ })).toBeVisible();
  await page.getByLabel("设定标题").fill("林远");
  await navigateAuthor(page, "创作对话");
  await expect(page.getByLabel("设定成果")).toHaveValue(/林远/);
  expect((await page.evaluate(() => window.novel.snapshot())).notes.find((n) => n.title === "林远")!.id).toBe(characterId);
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("大纲成果")).toHaveValue(/调查骗局/);
  await tools("故事规划");
  await expect(page.getByRole("button", { name: /写作提示/ })).toHaveCount(0);
  await expect(page.getByLabel("设定正文")).toHaveValue("收到包裹，调查骗局。");
  await navigateAuthor(page, "创作对话");
  await viewAuthorStage(page, "概要");
  await page.getByLabel("概要成果").fill("自由补写：父亲在旧码头等他。\n不能遗漏的结局细节。");
  await expect(page.getByLabel("阶段同步状态")).toContainText(/等待同步|正在同步/);
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料", { timeout: 15000 });
  await tools("创意与风格");
  await expect(page.getByLabel("简介与背景", { exact: true })).toHaveValue("自由补写：父亲在旧码头等他。\n不能遗漏的结局细节。");
  await app.close(); await launch();
  await page.getByRole("button", { name: "打开 未命名故事" }).click();
  await expect(page.getByLabel("概要成果")).toHaveValue(/不能遗漏的结局细节/);
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.screenshot({ path: "test-results/sync-minimum.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("ambiguous records preserve both versions until the author selects a stable link", async () => {
  // Catches silent merging of ambiguous records or missing author resolution controls.
  await overview();
  await page.evaluate(async () => {
    const p = (await window.novel.snapshot()).projects[0];
    for (const body of ["独立人物甲", "独立人物乙"]) await window.novel.invoke({ type: "note.save", projectId: p.id, noteType: "character", title: "林舟", body, sources: [] });
  });
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await viewAuthorStage(page, "设定");
  await expect(page.getByLabel("阶段同步状态")).toContainText("需要选择");
  expect((await page.evaluate(() => window.novel.snapshot())).notes.filter(n => n.type === "character").map((n) => n.body).sort()).toEqual(["独立人物乙", "独立人物甲"].sort());
  await expect(page.getByLabel("保留的辅助资料")).toContainText("独立人物甲");
  await page.screenshot({ path: "test-results/sync-conflict.png" });
  const ids = (await page.evaluate(() => window.novel.snapshot())).notes.filter(n => n.type === "character").map((n) => n.id);
  await page.getByLabel("关联记录：林舟").selectOption(ids[1]);
  await page.getByRole("button", { name: "采用阶段草稿", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  const s = await page.evaluate(() => window.novel.snapshot());
  expect(s.notes.filter(n => n.type === "character")).toHaveLength(2);
  expect(s.notes.find((n) => n.id === ids[0])!.body).toBe("独立人物甲");
  expect(s.notes.find((n) => n.id === ids[1])!.body).toBe("怕黑的整理师。");
});

test("removed managed records are archived and historical stage restore restores their bindings atomically", async () => {
  // Catches textarea-only history restoration and archive leakage into active lists.
  await overview();
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("设定成果")).toHaveValue(/林舟/);
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("大纲成果")).toHaveValue(/调查骗局/);
  const original = await page.evaluate(() => window.novel.snapshot());
  const noteId = original.notes.find((n) => n.type === "outline")!.id;
  const revision = original.projects[0].authoring!.documents.outline!.revision;
  await page.getByLabel("大纲成果").fill("");
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  await tools("故事规划");
  await expect(page.getByRole("button", { name: /骗局调查/ })).toHaveCount(0);
  await page.getByLabel("显示已归档资料").check();
  await page.getByRole("button", { name: /骗局调查/ }).click();
  await expect(page.getByRole("button", { name: "恢复归档资料", exact: true })).toBeVisible();
  await navigateAuthor(page, "创作对话");
  await page.getByText("成果历史", { exact: true }).click();
  await page.getByLabel("选择成果历史版本").selectOption(String(revision));
  await page.getByRole("button", { name: "恢复这份成果", exact: true }).click();
  await expect(page.getByLabel("大纲成果")).toHaveValue(/收到包裹，调查骗局/);
  const restored = await page.evaluate(() => window.novel.snapshot());
  expect(restored.notes.find((n) => n.id === noteId)!.archived).toBeFalsy();
  expect(restored.projects[0].authoring!.documents.outline!.sync!.bindings.some((b) => b.noteId === noteId)).toBe(true);
});


test("failed and stopped syncs keep free drafts visible and can be retried after restart", async () => {
  // Catches discarded drafts, missing retry/cancel controls, or implicit restart retries.
  await overview();
  normalizeMode = "invalid";
  await page.getByLabel("概要成果").fill("作者仍要保留这段自由草稿。");
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("同步未完成", { timeout: 15000 });
  await expect(page.getByLabel("概要成果")).toHaveValue("作者仍要保留这段自由草稿。");
  normalizeMode = "normal";
  await page.getByRole("button", { name: "重试同步", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  normalizeMode = "hold";
  await page.getByLabel("概要成果").fill("中断时也要保留这个结局。");
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("正在同步");
  await page.getByRole("button", { name: "停止同步", exact: true }).click();
  await expect(page.getByLabel("概要成果")).toHaveValue("中断时也要保留这个结局。");
  await app.close(); normalizeMode = "normal"; await launch();
  await page.getByRole("button", { name: "打开 未命名故事" }).click();
  await expect(page.getByLabel("概要成果")).toHaveValue("中断时也要保留这个结局。");
  await expect(page.getByRole("button", { name: "重试同步", exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.novel.snapshot())).projects[0].background).toBe("作者仍要保留这段自由草稿。");
  await page.getByRole("button", { name: "重试同步", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  expect((await page.evaluate(() => window.novel.snapshot())).projects[0].background).toBe("中断时也要保留这个结局。");
});

test("archived auxiliary records can be restored with their original identity", async () => {
  // Catches a restore action that creates a duplicate record or forgets its stage binding.
  await overview();
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("设定成果")).toHaveValue(/林舟/);
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("大纲成果")).toHaveValue(/调查骗局/);
  const noteId = (await page.evaluate(() => window.novel.snapshot())).notes.find(n => n.type === "outline")!.id;
  await page.getByLabel("大纲成果").fill("");
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  await tools("故事规划");
  await page.getByLabel("显示已归档资料").check();
  await page.getByRole("button", { name: /骗局调查/ }).click();
  await page.getByRole("button", { name: "恢复归档资料", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复归档资料", exact: true })).toHaveCount(0);
  await navigateAuthor(page, "创作对话");
  await expect(page.getByLabel("大纲成果")).toHaveValue(/收到包裹，调查骗局/);
  const state = await page.evaluate(() => window.novel.snapshot());
  expect(state.notes.filter(n => n.type === "outline")).toHaveLength(1);
  expect(state.projects[0].authoring!.documents.outline!.sync!.bindings.some(b => b.noteId === noteId)).toBe(true);
});

test("concurrent draft and auxiliary edits remain visible until the author chooses auxiliary records", async () => {
  // Catches silent overwrites when both editors have changed or a records action that only clears status.
  await overview();
  await page.getByLabel("创作消息").fill((await windowStage()) === "overview" ? "请生成设定" : "请生成大纲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("设定成果")).toHaveValue(/林舟/);
  await page.getByLabel("设定成果").fill("阶段草稿：林舟准备离开小城。");
  await tools("人物与世界");
  await page.getByLabel("设定正文").fill("辅助资料：林舟决定留下照顾父亲。");
  await navigateAuthor(page, "创作对话");
  await expect(page.getByLabel("阶段同步状态")).toContainText("需要选择");
  await expect(page.getByLabel("设定成果")).toHaveValue("阶段草稿：林舟准备离开小城。");
  await expect(page.getByLabel("保留的辅助资料")).toContainText("辅助资料：林舟决定留下照顾父亲。");
  await page.getByRole("button", { name: "采用辅助资料", exact: true }).click();
  await expect(page.getByLabel("阶段同步状态")).toContainText("已整理到故事资料");
  await expect(page.getByLabel("设定成果")).toHaveValue(/辅助资料：林舟决定留下照顾父亲/);
  expect((await page.evaluate(() => window.novel.snapshot())).projects[0].authoring!.documents.settings!.history.some(h => h.content === "阶段草稿：林舟准备离开小城。")).toBe(true);
});
