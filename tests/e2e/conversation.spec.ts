import { navigateAuthor, customConnection, viewAuthorStage } from "./support/author-navigation";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { normalizationReply } from "./support/sync-fixture";
let app: ElectronApplication, page: Page, dir: string;
async function launch() {
  app = await electron.launch({
    args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
}
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-chat-e2e-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

test("conversation recovery shows progress, saves once and loads the original replies on demand", async () => {
  let calls = 0;
  let releaseMalformed: (() => void) | undefined, releaseRepair: (() => void) | undefined;
  const result = { message: "开篇已保存", chapters: [{ title: "雨夜", content: "雨落在旧书店的玻璃上。门铃响了。", stage: "opening" }], memory: "保留雨夜书店的共识" };
  const malformed = JSON.stringify({ message: result.message, chapters: result.chapters }) + ',"memory":"保留雨夜书店的共识"}';
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the request. */ }
    calls++;
    const respond = (content: string) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } }));
    };
    if (calls === 1) respond("");
    else if (calls === 2) releaseMalformed = () => respond(malformed);
    else releaseRepair = () => respond(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    await page.evaluate(async baseUrl => {
      await window.novel.invoke({ type: "profile.save", name: "恢复验收", baseUrl, model: "fixture", purpose: "writing" });
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.getByLabel("创作消息").fill("先试写一段雨夜书店的开篇");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    await expect(page.getByRole("status").filter({ hasText: "正在重新获取回复" })).toBeVisible();
    releaseMalformed!();
    await expect.poll(() => calls).toBe(3);
    await expect(page.getByRole("status").filter({ hasText: "正在整理回复格式" })).toBeVisible();
    releaseRepair!();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(result.chapters[0].content);
    await page.getByText("本轮用量", { exact: true }).click();
    await expect(page.getByText("900 Token", { exact: true })).toBeVisible();
    await expect(page.getByText("本轮共 3 次请求，包含自动恢复。", { exact: true })).toBeVisible();
    await page.getByText("查看本轮回复与恢复记录", { exact: true }).click();
    await expect(page.getByText("第 3 次 · 整理回复格式", { exact: true })).toBeVisible();
    await page.getByText("查看原始回复", { exact: true }).first().click();
    await expect(page.locator(".conversation-recovery pre").filter({ hasText: malformed })).toBeVisible();
    const snapshot = await page.evaluate(() => window.novel.snapshot());
    expect(snapshot.chapters).toHaveLength(1);
    expect(snapshot.conversations[0].attempts).toHaveLength(3);
    expect(calls).toBe(3);
    await page.screenshot({ path: "docs/screenshots/conversation-recovery-20261012.png", fullPage: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("title-optional conversation creates, edits, continues and restores a manuscript across restart", async () => {
  let call = 0,
    chapterId = "",
    sawEdit = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const normalized = normalizationReply(body);
    if (!normalized) call++;
    if (!normalized && call === 3)
      sawEdit = JSON.stringify(body.messages).includes("作者手改的开头");
    const output = normalized ?? (
      call === 1
        ? {
            message: "我推荐遗物整理师收到自己的遗物。",
            suggestions: ["按推荐，先写一段"],
            memory: "轻松悬疑",
          }
        : call === 2
          ? {
              message: "开篇已保存，读读看这个感觉。",
              project: { title: "自己的遗物" },
              notes: [
                { type: "character", title: "林舟", body: "嘴贫的遗物整理师" },
              ],
              chapters: [
                {
                  title: "包裹",
                  content: "林舟收到自己的遗物。他说：这售后也太早了。",
                  stage: "opening",
                },
              ],
              suggestions: ["继续完成这一章"],
            }
          : {
              message: "第一章完成，下一章可以让寄件人现身。",
              chapters: [
                {
                  id: chapterId,
                  title: "包裹",
                  content: "作者手改的开头。陌生的电话突然响起。",
                  stage: "complete",
                },
              ],
              suggestions: ["继续下一章"],
            });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 150,
          total_tokens: 250,
        },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "和 AI 一起写故事" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "连接 AI" }),
    ).toBeVisible();
    await page.evaluate(
      async (baseUrl) => {
        await window.novel.invoke({
          type: "profile.save",
          name: "本地验收",
          baseUrl,
          model: "fixture",
          purpose: "writing",
        });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page.getByLabel("创作消息").fill("没有想法，给我推荐一个悬疑故事");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page
      .getByRole("button", { name: "按推荐，先写一段", exact: true })
      .click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      /这售后也太早了/,
    );
    const snapshot = await page.evaluate(() => window.novel.snapshot());
    chapterId = snapshot.chapters[0].id;
    expect(snapshot.notes[0].title).toBe("林舟");
    await page.getByLabel("章节正文", { exact: true }).fill("作者手改的开头。");
    await page
      .getByRole("button", { name: "继续完成这一章", exact: true })
      .click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "作者手改的开头。陌生的电话突然响起。",
    );
    expect(sawEdit).toBe(true);
    expect(
      (await page.evaluate(() => window.novel.snapshot())).chapters,
    ).toHaveLength(1);
    await page.getByRole("button", { name: "历史版本", exact: true }).click();
    await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "作者手改的开头。",
    );
    await page.getByRole("button", { name: "历史版本", exact: true }).click();
    await page.getByLabel("创作消息").fill("下一章让寄件人出现");
    await page.screenshot({ path: "test-results/conversation-desktop.png" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1050, 680),
    );
    await page.screenshot({ path: "test-results/conversation-minimum.png" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await app.close();
    await launch();
    await page.getByRole("button", { name: "打开 自己的遗物" }).click();
    await expect(
      page.getByText("第一章完成，下一章可以让寄件人现身。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "作者手改的开头。",
    );
    await expect(page.getByLabel("创作消息")).toHaveValue("下一章让寄件人出现");
  } finally {
    await new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  }
});

test("existing works open directly into conversation with readable current drafts and auxiliary tools", async () => {
  await page.evaluate(async () => {
    const p = await window.novel.invoke({
      type: "project.create",
      title: "旧作品",
    });
    if (!p.ok) throw Error();
    const c = await window.novel.invoke({
      type: "chapter.create",
      projectId: p.entityId,
      ordinal: 1,
      title: "已有章节",
    });
    if (!c.ok) throw Error();
    await window.novel.invoke({
      type: "chapter.save",
      id: c.entityId,
      revision: 1,
      content: "没有确认过的现有草稿",
    });
  });
  await page.getByRole("button", { name: "打开 旧作品" }).click();
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "没有确认过的现有草稿",
  );
  await navigateAuthor(page, "辅助工具");
  await navigateAuthor(page, "创意与风格");
  await expect(page.getByLabel("简介与背景", { exact: true })).toBeVisible();
  await navigateAuthor(page, "创作对话");
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "没有确认过的现有草稿",
  );
});

test("rewrite approval, setting history and cancellation stay inside the conversation workspace", async () => {
  let calls = 0,
    chapterIds: string[] = [],
    noteId = "";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const normalized = normalizationReply(JSON.parse(raw));
    if (!normalized) calls++;
    if (!normalized && calls === 3) return;
    const output = normalized ?? (
      calls <= 2
        ? {
            message: "职业调整涉及前两章。",
            chapters: chapterIds.map((id, i) => ({
              id,
              title: `章${i + 1}`,
              content: "保险调查员走进房间。",
              stage: "complete",
            })),
            notes: [
              {
                id: noteId,
                type: "character",
                title: "林舟",
                body: "保险调查员，怕黑",
              },
            ],
          }
        : {
            message: "下一章已保存。",
            chapters: [
              {
                title: "来访者",
                content: "一个陌生人出现在门口。",
                stage: "complete",
              },
            ],
          });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const seeded = await page.evaluate(
      async (baseUrl) => {
        const p = await window.novel.invoke({
          type: "project.create",
          title: "回改验收",
        });
        if (!p.ok) throw Error();
        const ids: string[] = [];
        for (let ordinal = 1; ordinal <= 2; ordinal++) {
          const c = await window.novel.invoke({
            type: "chapter.create",
            projectId: p.entityId,
            ordinal,
            title: `章${ordinal}`,
          });
          if (!c.ok) throw Error();
          await window.novel.invoke({
            type: "chapter.save",
            id: c.entityId,
            revision: 1,
            content: "遗物整理师在工作。",
          });
          ids.push(c.entityId);
        }
        const n = await window.novel.invoke({
          type: "note.save",
          projectId: p.entityId,
          noteType: "character",
          title: "林舟",
          body: "遗物整理师，怕黑",
          sources: [],
        });
        if (!n.ok) throw Error();
        await window.novel.invoke({
          type: "profile.save",
          name: "对话验收",
          baseUrl,
          model: "fixture",
          purpose: "writing",
        });
        return { ids, noteId: n.entityId };
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    chapterIds = seeded.ids;
    noteId = seeded.noteId;
    await page.getByRole("button", { name: "打开 回改验收" }).click();
    await page.getByLabel("创作消息").fill("把主角改成保险调查员");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "一起改", exact: true }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => window.novel.snapshot())).chapters.every(
        (c) => c.content === "遗物整理师在工作。",
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "一起改", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "保险调查员走进房间。",
    );
    await page
      .getByRole("button", { name: "创作资料 · 1", exact: true })
      .click();
    await page.getByText("设定历史 · 1 个版本", { exact: true }).click();
    await page
      .getByRole("button", { name: "恢复这份设定", exact: true })
      .click();
    await expect(page.locator(".conversation-notes > .card > pre")).toHaveText(
      "遗物整理师，怕黑",
    );
    await viewAuthorStage(page, "正文");
    await page.getByLabel("创作消息").fill("继续下一章");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => calls).toBe(3);
    await page.getByRole("button", { name: "停止本轮", exact: true }).click();
    await page.getByRole("button", { name: "重新尝试", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "一个陌生人出现在门口。",
    );
    expect(
      (await page.evaluate(() => window.novel.snapshot())).chapters,
    ).toHaveLength(3);
  } finally {
    await new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  }
});
