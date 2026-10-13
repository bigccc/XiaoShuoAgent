import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { normalizationReply } from "./support/sync-fixture";
let app: ElectronApplication, page: Page, dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-author-ui-"));
  app = await electron.launch({
    // UI fixtures must not request access to the author's real Safe Storage key.
    args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
});
test.afterEach(async () => {
  // A failed dirty-form assertion must not leave the test process waiting for
  // the author's close confirmation. These are disposable test workspaces.
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
test("author can start with an idea and edit a story through three work areas without technical settings", async () => {
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "创作导航" });
  await expect(nav.getByRole("button")).toHaveText(["书架", "创作", "看稿", "故事资料", "设置"]);
  await expect(page.getByRole("button", { name: "我有一个想法", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "我有一个想法", exact: true }).click();
  await expect(page.getByLabel("创作消息")).toBeFocused();
  await expect(page.getByLabel("创作 Token 预算")).not.toBeVisible();
  await nav.getByRole("button", { name: "故事资料", exact: true }).click();
  await page.getByLabel("简介与背景", { exact: true }).fill("一位少女寻找会说话的猫。");
  await nav.getByRole("button", { name: "看稿", exact: true }).click();
  await expect(page.getByText("先在创作中写下第一章，再来看稿。")).toBeVisible();
  await nav.getByRole("button", { name: "故事资料", exact: true }).click();
  await expect(page.getByLabel("简介与背景", { exact: true })).toHaveValue("一位少女寻找会说话的猫。");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("button", { name: "导出 Word（DOCX）", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "备份完整作品", exact: true })).toBeVisible();
});
test("AI connection presets need no manual model fields and custom settings keep navigation protection", async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "添加 AI 连接", exact: true }).first().click();
  await expect(page.getByLabel("服务商")).toHaveValue("deepseek");
  await expect(page.getByLabel("API 地址", { exact: true })).not.toBeVisible();
  await page.getByLabel("API 密钥").fill("author-test-key");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  const state = await page.evaluate(() => window.novel.snapshot());
  expect(state.profiles[0]).toMatchObject({ name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", purpose: "writing", hasKey: true });
  expect(JSON.stringify(state)).not.toContain("author-test-key");
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByLabel("配置名称").fill("未保存的名字");
  await page.getByRole("button", { name: "书架", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
});

test("a new author confirms direction and preparation, then gets a saved first chapter and a usable narrow pane switch", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const normalization = normalizationReply(body);
    if (!normalization) calls++;
    const response = normalization ?? (calls === 1
      ? { message: "推荐少女寻找会说话的猫的故事。", artifacts: [{ stage: "overview", blocks: [{ kind: "field", field: "background", text: "少女寻找会说话的猫，最终找回失去的家人。" }] }] }
      : calls === 2
        ? { message: "人物和大纲已准备，请查看后确认。", artifacts: [
            { stage: "settings", blocks: [{ kind: "note", noteType: "character", title: "阿宁", text: "勇敢的少女，寻找家人。" }] },
            { stage: "outline", blocks: [{ kind: "note", noteType: "outline", title: "故事大纲", text: "第一章在雨巷遇见猫，后来找回家人。" }] },
          ] }
        : { message: "第一章已保存。", chapters: [{ title: "雨巷", content: "阿宁听见巷口的猫叫出她的名字。", stage: "opening" }] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }], usage: { total_tokens: 300, prompt_tokens: 100, completion_tokens: 200 } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    await page.evaluate(async baseUrl => { await window.novel.invoke({ type: "profile.save", name: "创作连接", baseUrl, model: "fixture", purpose: "writing" }); }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    await page.getByLabel("创作消息").fill("我想写少女寻找猫的故事");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByLabel("概要成果")).toHaveValue(/找回失去的家人/);
    await page.getByRole("button", { name: "确认方向，做准备", exact: true }).click();
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => window.novel.snapshot());
      return { stage: snapshot.projects[0].authoring?.activeStage, status: snapshot.conversations.at(-1)?.status, error: snapshot.conversations.at(-1)?.error ?? "" };
    }).toEqual({ stage: "outline", status: "completed", error: "" });
    await expect(page.getByLabel("大纲成果")).toHaveValue(/雨巷遇见猫/);
    const preparation = await page.evaluate(() => window.novel.snapshot());
    expect(preparation.projects[0].authoring!.reviewGroup).toEqual(["settings", "outline"]);
    expect(preparation.projects[0].authoring!.documents.overview!.approved).toBe(true);
    expect(preparation.chapters).toHaveLength(0);
    await page.getByRole("button", { name: "按推荐继续", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue("阿宁听见巷口的猫叫出她的名字。");
    expect(calls).toBe(3);
    await page.screenshot({ path: "docs/screenshots/author-ui-wide-20261013.png" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
    await expect(page.getByRole("button", { name: "聊天", exact: true })).toBeVisible();
    await expect(page.getByLabel("章节正文", { exact: true })).not.toBeVisible();
    await page.getByRole("button", { name: "稿件", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "docs/screenshots/author-ui-narrow-20261013.png" });
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
