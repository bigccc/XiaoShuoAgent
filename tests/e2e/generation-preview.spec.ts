import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizationReply } from "./support/sync-fixture";

let app: ElectronApplication, page: Page, dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-stream-preview-"));
  app = await electron.launch({
    args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
function chunk(res: ServerResponse, content: string) {
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
}
function finish(res: ServerResponse) {
  res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } })}\n\ndata: [DONE]\n\n`);
}
async function setup(port: number) {
  await page.evaluate(async baseUrl => {
    const project = await window.novel.invoke({ type: "project.create", title: "流式预览验收", chapterWords: 100 });
    if (!project.ok) throw Error(project.error.message);
    const profile = await window.novel.invoke({ type: "profile.save", pricing: { currency: "CNY", input: 0, output: 0 }, name: "流式验收模型", baseUrl, model: "fixture", purpose: "writing" });
    if (!profile.ok) throw Error(profile.error.message);
  }, `http://127.0.0.1:${port}/v1`);
  await page.getByRole("button", { name: "打开 流式预览验收" }).click();
}
async function send(text: string) {
  await page.getByLabel("创作消息").fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

for (const kind of ["chapter", "artifact", "blocks"] as const) {
  test(`${kind}: visible SSE content precedes response end, survives renderer reload and saves once`, async ({}, testInfo) => {
    let response: ServerResponse | undefined;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const normalized = normalizationReply(JSON.parse(raw));
      if (normalized) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(normalized) }, finish_reason: "stop" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      response = res;
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await setup((server.address() as { port: number }).port);
      await send(kind === "chapter" ? "先试写一段开篇" : "帮我规划故事背景");
      await expect.poll(() => !!response).toBe(true);
      const message = "预览消息逐字出现";
      const prose = "雨落在旧书店的玻璃上。门铃响了。";
      const output = kind === "chapter"
        ? { message, chapters: [{ title: "雨夜", content: prose, stage: "opening" }] }
        : { message, artifacts: [kind === "artifact"
          ? { stage: "overview", content: prose }
          : { stage: "overview", blocks: [{ kind: "field", field: "background", text: prose }] }] };
      const json = JSON.stringify(output);
      const cut = json.indexOf(prose) + prose.length;
      const started = Date.now();
      chunk(response!, json.slice(0, cut));
      const preview = page.getByRole("region", { name: "生成预览", exact: true });
      await expect(preview).toContainText(prose, { timeout: 450 });
      await expect(preview).toBeVisible({ timeout: 50 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(500);
      expect(response!.writableEnded).toBe(false);
      await expect(preview).toContainText(message);
      const path = kind === "chapter" ? "chapters.0.content" : kind === "artifact" ? "artifacts.0.content" : "artifacts.0.blocks.0.text";
      await expect(preview.locator(`[data-path="${path}"]`)).toContainText(prose);
      await expect(preview.getByRole("status")).not.toContainText(prose);
      await expect(preview).toContainText("生成中预览，尚未保存");
      await expect(page.getByRole("log", { name: "创作对话记录" }).getByRole("region", { name: "生成预览", exact: true })).toBeVisible();
      const before = await page.evaluate(() => window.novel.snapshot());
      expect(before.chapters).toHaveLength(0);
      expect(before.projects[0].background).not.toContain(prose);
      await page.reload();
      await page.waitForLoadState();
      // Renderer reload must recover the active main-process snapshot, without another model request.
      const reopen = page.getByRole("button", { name: "打开 流式预览验收" });
      await expect(preview.or(reopen)).toBeVisible();
      if (await reopen.isVisible()) await reopen.click();
      await expect(preview).toContainText(prose);
      await page.screenshot({ path: testInfo.outputPath(`${kind}-preview-before-end.png`) });
      chunk(response!, json.slice(cut));
      finish(response!);
      await expect(preview).toHaveCount(0);
      const after = await page.evaluate(() => window.novel.snapshot());
      if (kind === "chapter") {
        expect(after.chapters).toHaveLength(1);
        expect(after.chapters[0].content).toBe(prose);
        await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(prose);
      } else expect(after.projects[0].background).toBe(prose);
      expect(after.conversations.filter(item => item.status === "completed")).toHaveLength(1);
      await testInfo.attach("stream-first-visible-latency", { body: JSON.stringify({ milliseconds: elapsed, ended: false }), contentType: "application/json" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test("cancel clears visible preview and rejects late SSE content", async () => {
  let response: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Wait for controlled content. */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    response = res;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await setup((server.address() as { port: number }).port);
    await send("先试写开篇");
    await expect.poll(() => !!response).toBe(true);
    chunk(response!, '{"message":"取消前可见片段');
    const preview = page.getByRole("region", { name: "生成预览", exact: true });
    await expect(preview).toContainText("取消前可见片段");
    await page.getByRole("button", { name: "停止本轮", exact: true }).click();
    await expect(preview).toHaveCount(0);
    chunk(response!, '迟到内容不得出现","chapters":[{"title":"迟到","content":"迟到内容不得保存","stage":"opening"}]}');
    finish(response!);
    await expect(page.getByText("迟到内容不得出现")).toHaveCount(0);
    expect((await page.evaluate(() => window.novel.snapshot())).chapters).toHaveLength(0);
    await page.reload();
    await page.getByRole("button", { name: "打开 流式预览验收" }).click();
    await expect(preview).toHaveCount(0);
    expect((await page.evaluate(() => window.novel.snapshot())).chapters).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("writing streams prose after phase-only planning and holds persistence until completion", async ({}, testInfo) => {
  let planning: ServerResponse | undefined, generation: ServerResponse | undefined;
  const prose = "林舟推开书店的木门，门铃在雨声里响起。他把湿伞放进桶里，仔细看了看柜台上的信。".repeat(5).slice(0, 100);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const system = body.messages.find((message: { role: string }) => message.role === "system")?.content ?? "";
    if (system.includes("连续写作·规划") || system.includes("连续写作·生成")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      if (system.includes("连续写作·规划")) planning = res;
      else generation = res;
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ issues: [], majorChange: false, reason: "" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await setup((server.address() as { port: number }).port);
    await send("写完前一章");
    await expect.poll(() => !!planning).toBe(true);
    const privatePlan = "规划内部文本不得作为正文预览";
    chunk(planning!, `{"plan":"${privatePlan}`);
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toBeVisible();
    await expect(page.getByRole("region", { name: "生成预览", exact: true }).getByText(privatePlan)).toHaveCount(0);
    chunk(planning!, '","majorChange":false,"reason":""}');
    finish(planning!);
    await expect.poll(() => !!generation).toBe(true);
    const json = JSON.stringify({ title: "雨夜", content: prose, majorChange: false, reason: "" });
    const cut = json.indexOf(prose) + prose.length;
    const started = Date.now();
    chunk(generation!, json.slice(0, cut));
    const preview = page.getByRole("region", { name: "生成预览", exact: true });
    await expect(preview).toContainText(prose, { timeout: 450 });
    await expect(preview).toBeVisible({ timeout: 50 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
    expect(generation!.writableEnded).toBe(false);
    await expect(preview).toContainText("生成中预览，尚未保存");
    expect((await page.evaluate(() => window.novel.snapshot())).chapters).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("writing-preview-before-end.png") });
    chunk(generation!, json.slice(cut));
    finish(generation!);
    await expect(card).toContainText("任务已完成", { timeout: 30000 });
    await expect(preview).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.novel.snapshot());
    expect(snapshot.chapters).toHaveLength(1);
    expect(snapshot.chapters[0].content).toBe(prose);
    await testInfo.attach("stream-first-visible-latency", { body: JSON.stringify({ milliseconds: elapsed, ended: false }), contentType: "application/json" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
