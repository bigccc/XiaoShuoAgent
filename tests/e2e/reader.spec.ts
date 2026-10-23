import { navigateAuthor, customConnection } from "./support/author-navigation";
import {
  _electron as electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
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
  dir = await mkdtemp(join(tmpdir(), "novel-reader-ui-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
test("reader searches exact passage, captures selected annotation and retains review and reading position after restart", async () => {
  await page.evaluate(async () => {
    const p = await window.novel.invoke({
      type: "project.create",
      title: "长篇验收",
    });
    if (!p.ok) throw Error("create");
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      const c = await window.novel.invoke({
        type: "chapter.create",
        projectId: p.entityId,
        ordinal,
        title: `故事${ordinal}`,
      });
      if (!c.ok) throw Error("chapter");
      await window.novel.invoke({
        type: "chapter.save",
        id: c.entityId,
        revision: c.revision!,
        content: `开头${ordinal}。\n\n他走进雨里。\n\n他走进雨里。\n\n终点${ordinal}。`,
      });
    }
  });
  await page.getByRole("button", { name: "打开 长篇验收" }).click();
  await navigateAuthor(page, "阅读与审阅");
  await expect(
    page.getByRole("heading", { name: "故事1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "故事2", exact: true }),
  ).toBeAttached();
  await page.getByLabel("全文搜索").fill("终点4");
  await page.getByRole("button", { name: "搜索正文", exact: true }).click();
  await page.getByRole("button", { name: /第4章.*终点4/ }).click();
  await expect(
    page.getByRole("heading", { name: "故事4", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "审阅", exact: true }).click();
  const body = page.locator('.reader-chapter[data-active="true"] .reader-text');
  await body.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (n.textContent?.includes("他走进雨里。")) {
        const r = document.createRange();
        const start = n.textContent!.indexOf("他走进雨里。", 7);
        r.setStart(n, start);
        r.setEnd(n, start + 6);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(r);
        break;
      }
    }
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(page.getByText("选中 6 字", { exact: true })).toBeVisible();
  await page.getByLabel("批注内容").fill("这里的雨要与前章呼应");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect(
    page.getByText("这里的雨要与前章呼应", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "标记本章已审", exact: true }).click();
  await expect(page.getByText("本章已审", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/reader-review.png" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 680),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/reader-minimum.png" });
  await app.close();
  await launch();
  await page.getByRole("button", { name: "打开 长篇验收" }).click();
  await navigateAuthor(page, "阅读与审阅");
  await expect(
    page.getByRole("heading", { name: "故事4", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("这里的雨要与前章呼应", { exact: true }),
  ).toBeVisible();
  const s = await page.evaluate(() => window.novel.snapshot());
  expect(s.readingWorkspaces![0].annotations[0].anchor.start).toBe(14);
  expect(s.readingWorkspaces![0].position?.mode).toBe("review");
  const originalRevision = s.chapters.find((c) => c.ordinal === 4)!.revision;
  await page.evaluate(async () => {
    const state = await window.novel.snapshot();
    const project = state.projects[0];
    const result = await window.novel.invoke({
      type: "note.save",
      projectId: project.id,
      noteType: "world",
      title: "上游设定",
      body: "故事发生在雨夜。",
      sources: [],
    });
    if (!result.ok) throw Error(result.error.message);
  });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.novel.snapshot())).chapters.find(
          (c) => c.ordinal === 4,
        )!.revision,
    )
    .toBeGreaterThan(originalRevision);
  // Reload the renderer so the quote navigation exercises the new metadata revision.
  await page.reload();
  await page.getByRole("button", { name: "打开 长篇验收" }).click();
  await navigateAuthor(page, "阅读与审阅");
  await expect(page.getByText("本章已审", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "他走进雨里。", exact: true }).click();
  await expect(
    page.getByText("原文已变化，无法唯一定位这条批注，请重新核对。", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.novel.snapshot()))
          .readingWorkspaces![0].position!.offset,
    )
    .toBe(14);

  await page.evaluate(async () => {
    const state = await window.novel.snapshot();
    const c = state.chapters.find((c) => c.ordinal === 4)!;
    const changed = await window.novel.invoke({
      type: "chapter.save",
      id: c.id,
      revision: c.revision,
      content: "手动新增开场。\n\n" + c.content,
    });
    if (!changed.ok) throw Error(changed.error.message);
  });
  await expect(
    page.getByText("正文已改动 · 待复核", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "他走进雨里。", exact: true }).click();
  await expect(
    page.getByText("原文已变化，无法唯一定位这条批注，请重新核对。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("与上次已审正文比较", { exact: true }).click();
  await expect(page.locator(".paragraph-changes .diff-added")).toContainText(
    "手动新增开场。",
  );
});

test("5,000 chapter reader bounds directory and prose DOM, locates final chapters and preserves position-only metadata", async () => {
  test.setTimeout(120000);
  const ids = await page.evaluate(async () => {
    const p = await window.novel.invoke({
      type: "project.create",
      title: "五千章长篇",
    });
    if (!p.ok) throw Error("create");
    const c = await window.novel.invoke({
      type: "chapter.create",
      projectId: p.entityId,
      ordinal: 1,
      title: "长篇第1章",
    });
    if (!c.ok) throw Error("chapter");
    return { projectId: p.entityId, chapterId: c.entityId };
  });
  await app.evaluate(
    async (_electron, args) => {
      const { DatabaseSync } = (process as any).getBuiltinModule("node:sqlite");
      const { createHash } = (process as any).getBuiltinModule("node:crypto");
      const db = new DatabaseSync(args.path);
      const template = JSON.parse(
        String(
          db
            .prepare("SELECT json FROM chapters WHERE id=?")
            .get(args.chapterId)!.json,
        ),
      );
      const insert = db.prepare(
        "INSERT OR REPLACE INTO chapters(id,json,words,content_hash) VALUES(?,?,?,?)",
      );
      const history = db.prepare(
        "INSERT OR REPLACE INTO versions(id,json) VALUES(?,?)",
      );
      db.exec("BEGIN");
      for (let i = 1; i <= 5000; i++) {
        const id = i === 1 ? args.chapterId : `scale-chapter-${i}`;
        const content =
          `全书正文第${i}章。\n\n` +
          "长篇正文。".repeat(600) +
          (i === 4999 ? "目标结尾线索" : "");
        const chapter = {
          ...template,
          id,
          ordinal: i,
          title: `长篇第${i}章`,
          content,
        };
        insert.run(
          id,
          JSON.stringify(chapter),
          content.replace(/\s/g, "").length,
          createHash("sha256").update(content).digest("hex"),
        );
        history.run(
          `scale-history-${i}`,
          JSON.stringify({
            id: `scale-history-${i}`,
            chapterId: id,
            projectId: args.projectId,
            chapterRevision: 1,
            title: chapter.title,
            content,
            createdAt: template.createdAt,
            reason: "create",
            sourceRevisions: [],
          }),
        );
      }
      db.exec("COMMIT");
      db.close();
    },
    { ...ids, path: join(dir, "works.sqlite") },
  );
  await app.close();
  await launch();
  await page.getByRole("button", { name: "打开 五千章长篇" }).click();
  await navigateAuthor(page, "阅读与审阅");
  await expect(
    page.getByRole("heading", { name: "长篇第1章", exact: true }),
  ).toBeVisible();
  expect(
    await page.locator(".reader-directory-item").count(),
  ).toBeLessThanOrEqual(18);
  expect(await page.locator(".reader-chapter").count()).toBeLessThanOrEqual(3);
  await page.getByLabel("章号或标题").fill("4999");
  await page.getByRole("button", { name: /4999\. 长篇第4999章/ }).click();
  await expect(
    page.getByRole("heading", { name: "长篇第4999章", exact: true }),
  ).toBeVisible();
  await page.getByLabel("全文搜索").fill("目标结尾线索");
  await page.getByRole("button", { name: "搜索正文", exact: true }).click();
  await page.getByRole("button", { name: /第4999章.*目标结尾线索/ }).click();
  await expect(
    page.getByRole("button", { name: "下一章", exact: true }),
  ).toBeEnabled();
  const projection = await page.evaluate(async (projectId) => {
    const first = await window.novel.workspaceSnapshot(projectId);
    const position = await window.novel.invoke({
      type: "reading.position",
      projectId,
      chapterId: "scale-chapter-4999",
      offset: 100,
      mode: "reading",
    });
    if (!position.ok) throw Error(position.error.message);
    const changed = await window.novel.workspaceSnapshot(
      projectId,
      first.revision,
    );
    return {
      fullProse: first.state!.chapters.some((c) => c.content.length > 0),
      versions: first.state!.versions.length,
      metadata: first.state!.chapters.length,
      changedCount: changed.state!.chapters.length,
      unchanged: changed.chaptersUnchanged,
    };
  }, ids.projectId);
  expect(projection).toEqual({
    fullProse: false,
    versions: 0,
    metadata: 5000,
    changedCount: 0,
    unchanged: true,
  });
  await page.screenshot({ path: "test-results/reader-scale5000.png" });
});

test("reading selection reaches Agent unchanged, multi-chapter drafts need adoption and volume suggestions stay discussion", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const request = JSON.parse(raw);
    requests.push(request);
    let output: unknown = {
      message: "建议第一卷包含第1至2章，卷名雨夜；请确认后手动建卷。",
    };
    if (request.messages[0].content.includes("小说审阅改稿助手")) {
      const target = JSON.parse(request.messages.at(-1).content);
      output = target.selection
        ? { message: "已修改所选片段", replacement: "他走向晨光。" }
        : {
            message: "本章已检查并调整",
            chapters: [
              {
                id: target.chapter.id,
                title: target.chapter.title,
                content: target.chapter.content + "\n\n候选结尾。",
                stage: "complete",
              },
            ],
          };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
          total_tokens: 200,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.evaluate(
      async (baseUrl) => {
        await window.novel.invoke({
          type: "profile.save", pricing: { currency: "CNY", input: 0, output: 0 },
          name: "本机改稿验收",
          purpose: "writing",
          baseUrl,
          model: "fixture",
        });
        const p = await window.novel.invoke({
          type: "project.create",
          title: "选段改稿验收",
        });
        if (!p.ok) throw Error("project");
        for (let ordinal = 1; ordinal <= 2; ordinal++) {
          const c = await window.novel.invoke({
            type: "chapter.create",
            projectId: p.entityId,
            ordinal,
            title: `雨夜${ordinal}`,
          });
          if (!c.ok) throw Error("chapter");
          await window.novel.invoke({
            type: "chapter.save",
            id: c.entityId,
            revision: c.revision!,
            content:
              "开场。\n\n他走进雨里。\n\n中段。\n\n他走进雨里。\n\n收场。",
          });
        }
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page.getByRole("button", { name: "打开 选段改稿验收" }).click();
    await navigateAuthor(page, "阅读与审阅");
    const body = page.locator(
      '.reader-chapter[data-active="true"] .reader-text',
    );
    await expect(body).toContainText("他走进雨里。");
    await body.evaluate((el) => {
      const n = el.firstChild!;
      const offset = n.textContent!.lastIndexOf("他走进雨里。");
      const r = document.createRange();
      r.setStart(n, offset);
      r.setEnd(n, offset + 6);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await expect(
      page.getByRole("button", { name: "修改这段文字", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "修改这段文字", exact: true })
      .click();
    await expect(page.getByText("选段 6 字", { exact: true })).toBeVisible();
    await page
      .getByLabel("创作消息")
      .fill("请将选段改为走向晨光，保留其余内容");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => window.novel.snapshot());
        return s.revisionJobs?.at(-1)?.status;
      })
      .toBe("completed");
    const changed = await page.evaluate(() => window.novel.snapshot());
    expect(changed.chapters[0].content).toBe(
      "开场。\n\n他走进雨里。\n\n中段。\n\n他走向晨光。\n\n收场。",
    );
    expect(
      JSON.parse(requests[0].messages.at(-1).content).selection.start,
    ).toBe(18);
    await page.getByText("选择改稿范围", { exact: true }).click();
    await page.getByLabel("改稿范围", { exact: true }).selectOption("chapters");
    await page.getByLabel("改稿起始章").fill("1");
    await page.getByLabel("改稿结束章").fill("2");
    await page.getByLabel("创作消息").fill("在两章结尾加入一句自然的过渡");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("待审 2 章 · 未检查 0 章", { exact: true }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => window.novel.snapshot())).chapters[0].content,
    ).not.toContain("候选结尾。");
    await page.locator(".revision-candidate summary").nth(1).click();
    await expect(page.getByText(/与第1章（雨夜1）待审稿有关/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "采纳本章", exact: true }),
    ).toBeDisabled();
    await page.locator(".revision-candidate summary").nth(1).click();
    await page.locator(".revision-candidate summary").first().click();
    await expect(
      page.locator(".revision-candidate[open] .diff-added"),
    ).toContainText("候选结尾。");
    await page.getByRole("button", { name: "采纳本章", exact: true }).click();
    await expect
      .poll(async () =>
        (
          await page.evaluate(() => window.novel.snapshot())
        ).chapters[0].content.includes("候选结尾。"),
      )
      .toBe(true);
    await navigateAuthor(page, "阅读与审阅");
    await page
      .getByRole("button", { name: "帮我建议分卷", exact: true })
      .click();
    await expect(
      page.getByText("分卷建议 · 待手动确认", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("建议第一卷包含第1至2章，卷名雨夜；请确认后手动建卷。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => window.novel.snapshot())).revisionJobs,
    ).toHaveLength(2);
    expect(
      requests.filter((r) =>
        r.messages[0].content.includes("小说审阅改稿助手"),
      ),
    ).toHaveLength(3);
    await page.screenshot({ path: "test-results/reader-revision-chat.png" });
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});

test("revision budget pause, author clarification and cancellation retain checked scope and pending drafts", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const target = JSON.parse(JSON.parse(raw).messages.at(-1).content);
    calls++;
    const output =
      calls === 1
        ? { message: "主角是否知道真相？" }
        : target.chapter.title === "另一章"
          ? { message: "第二章需要作者确认线索是否公开？" }
          : {
              message: "根据作者回复调整",
              chapters: [
                {
                  id: target.chapter.id,
                  title: target.chapter.title,
                  content: "作者确认后生成的待审正文。",
                  stage: "complete",
                },
              ],
            };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
          total_tokens: 200,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.evaluate(
      async (baseUrl) => {
        const profile = await window.novel.invoke({
          type: "profile.save", pricing: { currency: "CNY", input: 0, output: 0 },
          name: "澄清测试",
          baseUrl,
          model: "fixture",
          purpose: "writing",
        });
        if (!profile.ok) throw Error("profile");
        const p = await window.novel.invoke({
          type: "project.create",
          title: "预算与澄清",
        });
        if (!p.ok) throw Error("project");
        for (let ordinal = 1; ordinal <= 2; ordinal++) {
          const c = await window.novel.invoke({
            type: "chapter.create",
            projectId: p.entityId,
            ordinal,
            title: ordinal === 1 ? "主角" : "另一章",
          });
          if (!c.ok) throw Error("chapter");
          await window.novel.invoke({
            type: "chapter.save",
            id: c.entityId,
            revision: c.revision!,
            content: "原始正文。",
          });
        }
        const job = await window.novel.invoke({
          type: "revision.start", billing: { budgetMicros: 0 },
          projectId: p.entityId,
          scope: "all",
          profileId: profile.entityId,
          text: "检查并调整全文线索",
          tokenBudget: 1,
        });
        if (!job.ok) throw Error(job.error.message);
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page.getByRole("button", { name: "打开 预算与澄清" }).click();
    await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
    expect(calls).toBe(0);
    await page.getByRole("button", { name: "手动续跑", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.novel.snapshot())).revisionJobs![0].tokenBudget).toBe(1);
    expect(calls).toBe(0);
    await expect(page.getByRole("button", { name: "增加本次调用额度并继续", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "增加本次调用额度并继续", exact: true }).click();
    await expect(
      page.getByText("主角是否知道真相？", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("待审 0 章 · 未检查 2 章", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("改稿澄清回复")
      .fill("主角已经知道真相，但没有告诉同伴。");
    await page
      .getByRole("button", { name: "回复并继续改稿", exact: true })
      .click();
    await expect(
      page.getByText("第二章需要作者确认线索是否公开？", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("待审 1 章 · 未检查 1 章", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(page.getByText("已取消", { exact: true })).toBeVisible();
    const state = await page.evaluate(() => window.novel.snapshot());
    expect(state.chapters.every((c) => c.content === "原始正文。")).toBe(true);
    expect(state.revisionJobs![0].candidates).toHaveLength(1);
    expect(state.revisionJobs![0].checkedChapterIds).toHaveLength(1);
    expect(state.revisionJobs![0].text).toContain("主角已经知道真相");
    await page.screenshot({
      path: "test-results/reader-revision-clarification.png",
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});
