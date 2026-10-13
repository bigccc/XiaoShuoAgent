import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

let app: ElectronApplication, page: Page, dir: string;
async function launch() {
  app = await electron.launch({
    args: process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
}
async function openProject(server: Server, existingContent = "") {
  await page.evaluate(async ({ baseUrl, existingContent }) => {
    const project = await window.novel.invoke({ type: "project.create", title: "连续写作验收", chapterWords: 100 });
    if (!project.ok) throw Error(project.error.message);
    const profile = await window.novel.invoke({ type: "profile.save", name: "写作验收模型", baseUrl, model: "fixture", purpose: "writing" });
    if (!profile.ok) throw Error(profile.error.message);
    if (existingContent) {
      const chapter = await window.novel.invoke({ type: "chapter.create", projectId: project.entityId, ordinal: 1, title: "已有第一章" });
      if (!chapter.ok) throw Error(chapter.error.message);
      const saved = await window.novel.invoke({ type: "chapter.save", id: chapter.entityId, revision: chapter.revision!, content: existingContent });
      if (!saved.ok) throw Error(saved.error.message);
    }
  }, { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, existingContent });
  await page.getByRole("button", { name: "打开 连续写作验收" }).click();
}
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-writing-ui-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

// Removing the writing job from the composer busy state, or routing these
// controls to conversation commands, must fail this real IPC/UI test.
test("continuous writing exposes its goal and can pause, survive restart, resume and cancel", async () => {
  let calls = 0;
  const server = createServer(async (req) => {
    for await (const _ of req) { /* Keep the model request pending until paused. */ }
    calls++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.getByLabel("创作消息").fill("帮我把前五章写完");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    let card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("第 1–5 章");
    await expect(card).toContainText("已保存 0 / 5 章");
    await expect(card).toContainText("已检查 0 / 5 章");
    await expect.poll(() => calls).toBe(1);
    await page.getByLabel("创作消息").fill("接着写五章");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await card.getByRole("button", { name: "暂停任务", exact: true }).click();
    await expect(card).toContainText("已暂停");
    await app.close();
    await launch();
    await page.getByRole("button", { name: "打开 连续写作验收" }).click();
    card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("已暂停");
    expect(calls).toBe(1);
    await card.getByRole("button", { name: "继续任务", exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    await card.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(card).toContainText("已取消");
    const state = await page.evaluate(() => window.novel.snapshot());
    expect(state.chapters).toHaveLength(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/continuous-writing-minimum.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Dropping the composer tokenBudget argument would start a model call instead
// of retaining this task for the user to increase its total budget.
test("continuous writing shares the composer budget and offers an increased budget on resume", async () => {
  let calls = 0;
  const server = createServer(async (req) => {
    for await (const _ of req) { /* Pending request is cancelled by the UI. */ }
    calls++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.locator(".model-choice > summary").click();
    await page.getByLabel("创作 Token 预算", { exact: true }).fill("1000");
    await page.getByLabel("创作消息").fill("写完前五章");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("本次调用已达到上限");
    await expect(card.getByRole("button", { name: "继续任务", exact: true })).toBeVisible();
    expect(calls).toBe(0);
    await page.getByRole("button", { name: "待处理 · 1", exact: true }).click();
    await expect(card).toBeVisible();
    await card.getByText("高级设置", { exact: true }).click();
    await card.getByLabel("连续写作 Token 总预算").fill("100000");
    await card.getByRole("button", { name: "继续任务", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await card.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(card).toContainText("已取消");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// A saved chapter must be visible before its check finishes; completing only
// the first chapter or claiming a save is a successful check both fail here.
test("one request saves five chapters sequentially and keeps saved and checked progress separate", async () => {
  let releaseCheck: (() => void) | undefined;
  let checks = 0;
  const generated: number[] = [];
  const bodyText = "林舟推开书店的木门，门铃在雨声里响起。他把湿伞放进桶里，仔细看了看柜台上的信。".repeat(5).slice(0, 100);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find((message: { role: string }) => message.role === "system")?.content ?? "";
    const input = JSON.parse(body.messages.at(-1).content);
    const respond = (output: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } }));
    };
    if (system.includes("连续写作·规划")) respond({ plan: "前五章依次描写收信、拜访、调查、发现和归来，保持林舟与雨夜书店的主线。", majorChange: false, reason: "" });
    else if (system.includes("连续写作·生成")) {
      generated.push(input.ordinal);
      respond({ title: `故事${input.ordinal}`, content: bodyText, majorChange: false, reason: "" });
    } else if (system.includes("连续写作·检查")) {
      checks++;
      if (checks === 1) releaseCheck = () => respond({ issues: [], majorChange: false, reason: "" });
      else respond({ issues: [], majorChange: false, reason: "" });
    } else if (system.includes("连续写作·跨章复核")) respond({ issues: [], majorChange: false, reason: "" });
    else { res.writeHead(500); res.end("Unexpected writing phase"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.getByLabel("创作消息").fill("写完前五章");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("已保存 1 / 5 章");
    await expect(card).toContainText("已检查 0 / 5 章");
    await expect(card).toContainText("已保存不代表检查全部通过");
    await expect.poll(() => !!releaseCheck).toBe(true);
    releaseCheck!();
    await expect(card).toContainText("任务已完成");
    await expect(card).toContainText("已保存 5 / 5 章");
    await expect(card).toContainText("已检查 5 / 5 章");
    expect(generated).toEqual([1, 2, 3, 4, 5]);
    const snapshot = await page.evaluate(() => window.novel.snapshot());
    expect(snapshot.chapters.map((chapter) => chapter.ordinal).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.chapters.every((chapter) => chapter.content === bodyText)).toBe(true);
    await card.getByRole("button", { name: "查看最新正文", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(bodyText);
    await expect(page.getByLabel("当前章节")).toHaveValue(snapshot.chapters.find((chapter) => chapter.ordinal === 5)!.id);
    await page.screenshot({ path: "test-results/continuous-writing-completed.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Author input must return to the same paused writing task; treating the
// clarification as a new conversation would leave this task unfinished.
test("a major story change remains pending until the author supplies a decision and continues", async () => {
  let planningCalls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find((message: { role: string }) => message.role === "system")?.content ?? "";
    const input = JSON.parse(body.messages.at(-1).content);
    let output: unknown;
    if (system.includes("连续写作·规划")) {
      planningCalls++;
      output = planningCalls === 1
        ? { plan: "需要改变主角身份才能采用这一方案。", majorChange: true, reason: "是否改变主角身份，需要作者决定。" }
        : { plan: "保留主角身份和已有主线，依次描写查信与来访。", majorChange: false, reason: "" };
    } else if (system.includes("连续写作·生成")) {
      output = { title: `故事${input.ordinal}`, content: "雨落在书店门口。林舟收好来信，等待旧友按约前来。".repeat(5).slice(0, 100), majorChange: false, reason: "" };
    } else if (system.includes("连续写作·检查") || system.includes("连续写作·跨章复核")) output = { issues: [], majorChange: false, reason: "" };
    else { res.writeHead(500); res.end("Unexpected writing phase"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.getByLabel("创作消息").fill("写完前两章");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("仍有待处理事项");
    await expect(card).toContainText("是否改变主角身份");
    expect((await page.evaluate(() => window.novel.snapshot())).chapters).toHaveLength(0);
    await card.getByLabel("连续写作补充说明").fill("保留主角身份，按原主线推进。");
    await card.getByRole("button", { name: "继续任务", exact: true }).click();
    await expect(card).toContainText("任务已完成");
    const state = await page.evaluate(() => window.novel.snapshot());
    expect(state.writingJobs).toHaveLength(1);
    expect(state.chapters).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Existing prose must remain untouched until its candidate is accepted in the
// established revision UI, even though later new chapters can already exist.
test("existing prose uses the existing revision review entry and is never silently overwritten", async () => {
  const original = ("他站着，一动不动地站着。" + "窗外雨声渐密，林舟看了看柜台上的信，屋里仍然安静。".repeat(5)).slice(0, 100);
  const revised = "林舟站在窗前，听着雨声落在屋檐上。他把来信放进抽屉，转身迎接敲门的旧友。".repeat(5).slice(0, 100);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find((message: { role: string }) => message.role === "system")?.content ?? "";
    const input = JSON.parse(body.messages.at(-1).content);
    let output: unknown;
    if (system.includes("连续写作·规划")) output = { plan: "保留已有第一章，第二章让旧友来访。", majorChange: false, reason: "" };
    else if (system.includes("连续写作·生成") || system.includes("连续写作·修订")) output = { title: `故事${input.ordinal}`, content: revised, majorChange: false, reason: "" };
    else if (system.includes("连续写作·检查") && input.ordinal === 1) {
      const source = String(input.context).match(/\[chapter:([^@\]]+)@(\d+)\]/);
      if (!source) { res.writeHead(500); res.end("Missing first-chapter source"); return; }
      output = { issues: [{ category: "style", impact: "local", reason: "第一句重复描述站立状态。", evidence: [{ quote: "他站着，一动不动地站着。", source: { kind: "chapter", id: source[1], revision: Number(source[2]) } }] }], majorChange: false, reason: "" };
    } else if (system.includes("连续写作·检查") || system.includes("连续写作·跨章复核")) output = { issues: [], majorChange: false, reason: "" };
    else { res.writeHead(500); res.end("Unexpected writing phase"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server, original);
    await page.getByLabel("创作消息").fill("写完前两章");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("仍有待处理事项");
    await expect(card).toContainText("已保存 2 / 2 章");
    const before = await page.evaluate(() => window.novel.snapshot());
    expect(before.chapters.find((chapter) => chapter.ordinal === 1)?.content).toBe(original);
    await card.getByRole("button", { name: "查看待审稿", exact: true }).click();
    const revisions = page.getByRole("region", { name: "Agent 改稿任务" });
    await expect(revisions).toBeVisible();
    await revisions.locator(".revision-candidate summary").click();
    await expect(revisions.locator(".diff-added")).toContainText("林舟站在窗前");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.getByRole("log", { name: "创作对话记录" }).boundingBox())!.height).toBeGreaterThan(120);
    await revisions.getByRole("button", { name: "采纳本章", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/continuous-writing-review-minimum.png" });
    await revisions.getByRole("button", { name: "采纳本章", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.novel.snapshot())).chapters.find((chapter) => chapter.ordinal === 1)?.content).toBe(revised);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
