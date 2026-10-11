import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AppServices } from "../src/main/services";
import { Store } from "../src/main/store";
import { ProjectFiles } from "../src/main/files";
import type { Command, CommandResult } from "../src/shared/types";

const apps: AppServices[] = [],
  dirs: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.dispose()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function id(r: CommandResult) {
  if (!r.ok) throw Error(r.error.message);
  return r.entityId;
}
function reply(res: ServerResponse, data: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: typeof data === "string" ? data : JSON.stringify(data),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    }),
  );
}
async function setup(
  handler: (body: any, res: ServerResponse) => void,
  options = {},
) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    handler(JSON.parse(raw), res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "novel-conversation-"));
  dirs.push(dir);
  const app = new AppServices({
    dataDir: dir,
    dialogs: { open: async () => null, save: async () => null },
    provider: { retryDelayMs: 1 },
    ...options,
  });
  apps.push(app);
  const projectId = id(
    await app.dispatch({ type: "project.create", title: "未命名故事" }),
  );
  id(
    await app.dispatch({
      type: "profile.save",
      name: "对话模型",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      model: "fixture",
      purpose: "writing",
    }),
  );
  return { app, projectId, dir };
}
async function send(
  app: AppServices,
  projectId: string,
  text: string,
  extra = {},
) {
  return id(
    await app.dispatch({
      type: "conversation.send",
      projectId,
      text,
      ...extra,
    } as Command),
  );
}
async function done(app: AppServices, turnId: string) {
  await expect
    .poll(
      () =>
        (app.snapshot() as any).conversations.find((t: any) => t.id === turnId)
          ?.status,
    )
    .not.toBe("running");
  return (app.snapshot() as any).conversations.find(
    (t: any) => t.id === turnId,
  );
}

// Missing auto-application, current-draft context or chapter reuse breaks this real service workflow.
it("discusses, saves an opening and settings, then completes the same edited chapter across restart", async () => {
  let call = 0,
    chapterId = "";
  const { app, projectId, dir } = await setup((body, res) => {
    call++;
    if (call === 1)
      return reply(res, {
        message: "推荐写遗物整理师。",
        suggestions: ["按推荐，先写一段"],
        memory: "作者偏好悬疑",
      });
    if (call === 2)
      return reply(res, {
        message: "开篇已写好。",
        memory: "主角林舟，嘴贫的遗物整理师",
        project: { title: "自己的遗物", genre: "悬疑" },
        notes: [{ type: "character", title: "林舟", body: "嘴贫的遗物整理师" }],
        chapters: [
          { title: "包裹", content: "林舟收到自己的遗物。", stage: "opening" },
        ],
      });
    expect(JSON.stringify(body.messages)).toContain("作者亲手修改的开头");
    expect(JSON.stringify(body.messages)).toContain("主角林舟");
    reply(res, {
      message: "第一章完成。",
      memory: "第一章结束于来电",
      chapters: [
        {
          id: chapterId,
          title: "包裹",
          content: "作者亲手修改的开头。电话突然响了。",
          stage: "complete",
        },
      ],
    });
  });
  expect(
    (await done(app, await send(app, projectId, "我没有想法"))).reply,
  ).toContain("推荐");
  expect(app.snapshot().chapters).toHaveLength(0);
  await done(app, await send(app, projectId, "按推荐，先写一段"));
  const opening = app.snapshot().chapters[0];
  chapterId = opening.id;
  expect(opening.content).toBe("林舟收到自己的遗物。");
  expect(app.snapshot().notes[0].body).toBe("嘴贫的遗物整理师");
  id(
    await app.dispatch({
      type: "chapter.save",
      id: opening.id,
      revision: opening.revision,
      content: "作者亲手修改的开头。",
    }),
  );
  await app.dispose();
  const reopened = new AppServices({
    dataDir: dir,
    dialogs: { open: async () => null, save: async () => null },
  });
  apps.push(reopened);
  expect((reopened.snapshot() as any).conversations).toHaveLength(2);
  const turn = await done(reopened, await send(reopened, projectId, "继续完成这一章"));
  expect(turn.status).toBe("completed");
  expect(reopened.snapshot().chapters).toHaveLength(1);
  expect(reopened.snapshot().chapters[0].content).toContain("电话突然响了");
  expect(
    reopened
      .snapshot()
      .versions.some((v) => v.content === "作者亲手修改的开头。"),
  ).toBe(true);
  const openingVersion = reopened
    .snapshot()
    .versions.find((v) => v.content === "林舟收到自己的遗物。");
  const current = reopened.snapshot().chapters[0];
  id(
    await reopened.dispatch({
      type: "chapter.restore",
      id: current.id,
      revision: current.revision,
      versionId: openingVersion!.id,
    }),
  );
  expect(reopened.snapshot().chapters[0].writingStage).toBe("opening");
});

it("rejects stale responses without overwriting author edits or partially applying settings", async () => {
  let release!: () => void;
  const { app, projectId } = await setup((_body, res) => {
    release = () =>
      reply(res, {
        message: "改好了",
        project: { title: "不应更新" },
        chapters: [
          {
            id: chapter.id,
            title: "改写",
            content: "迟到的AI正文",
            stage: "complete",
          },
        ],
      });
  });
  const chapterId = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "旧章",
    }),
  );
  const chapter = app.snapshot().chapters[0];
  const turnId = await send(app, projectId, "改写这一章");
  await expect.poll(() => !!release).toBe(true);
  id(
    await app.dispatch({
      type: "chapter.save",
      id: chapterId,
      revision: chapter.revision,
      content: "正在写的手稿",
    }),
  );
  release();
  const turn = await done(app, turnId);
  expect(turn.status).toBe("failed");
  expect(turn.error).toMatch(/修改|变化/);
  expect(app.snapshot().chapters[0].content).toBe("正在写的手稿");
  expect(app.snapshot().projects[0].title).toBe("未命名故事");
});

it("asks before changing earlier chapters and applies a confirmed proposal through ordinary conversation", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "需要回改两章中的职业描写。",
      memory: "职业改为调查员",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "保险调查员正在调查。",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    const c = id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `第${ordinal}章`,
      }),
    );
    id(
      await app.dispatch({
        type: "chapter.save",
        id: c,
        revision: 1,
        content: "遗物整理师正在工作。",
      }),
    );
  }
  chapters = app.snapshot().chapters;
  const proposal = await done(
    app,
    await send(app, projectId, "把主角改成保险调查员"),
  );
  expect(proposal.status).toBe("awaiting-author");
  expect(proposal.proposal.chapterIds).toHaveLength(2);
  expect(
    app.snapshot().chapters.every((c) => c.content.includes("遗物整理师")),
  ).toBe(true);
  const accepted = await done(app, await send(app, projectId, "一起改"));
  expect(accepted.status).toBe("completed");
  expect(
    app.snapshot().chapters.every((c) => c.content.includes("保险调查员")),
  ).toBe(true);
});

it("honors an explicit multi-chapter rewrite without another approval", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "改好了",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "重写正文",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (await done(app, await send(app, projectId, "把前两章一起改成轻松一点")))
      .status,
  ).toBe("completed");
  expect(app.snapshot().chapters.every((c) => c.content === "重写正文")).toBe(
    true,
  );
});

it("cancels, retries and never applies a cancelled late response", async () => {
  let release!: () => void,
    call = 0;
  const { app, projectId } = await setup((_body, res) => {
    if (++call === 1)
      release = () =>
        reply(res, {
          message: "迟到",
          chapters: [{ title: "旧", content: "取消的内容", stage: "opening" }],
        });
    else
      reply(res, {
        message: "重试成功",
        chapters: [{ title: "新", content: "重试的正文", stage: "opening" }],
      });
  });
  const turnId = await send(app, projectId, "试写开头");
  await expect.poll(() => !!release).toBe(true);
  id(
    await app.dispatch({ type: "conversation.cancel", id: turnId } as Command),
  );
  release();
  expect((await done(app, turnId)).status).toBe("cancelled");
  expect(app.snapshot().chapters).toHaveLength(0);
  const retryId = id(
    await app.dispatch({ type: "conversation.retry", id: turnId } as Command),
  );
  expect((await done(app, retryId)).status).toBe("completed");
  expect(app.snapshot().chapters[0].content).toBe("重试的正文");
});

it("does not apply malformed, foreign or excessive default chapter operations", async () => {
  let output: any = "不是JSON";
  const { app, projectId } = await setup((_body, res) => reply(res, output));
  expect((await done(app, await send(app, projectId, "试写"))).status).toBe(
    "failed",
  );
  output = {
    message: "结果",
    project: { title: "不应保存" },
    chapters: [
      { id: "another-book", title: "章", content: "正文", stage: "complete" },
    ],
  };
  expect((await done(app, await send(app, projectId, "继续"))).status).toBe(
    "failed",
  );
  output = {
    message: "结果",
    chapters: [1, 2].map((n) => ({
      title: `章${n}`,
      content: "正文",
      stage: "complete",
    })),
  };
  expect((await done(app, await send(app, projectId, "继续"))).status).toBe(
    "failed",
  );
  expect(app.snapshot().chapters).toHaveLength(0);
  expect(app.snapshot().projects[0].title).toBe("未命名故事");
});

it("keeps a failed foreign response from poisoning portable backups", async () => {
  const { app, projectId, dir } = await setup((_body, res) =>
    reply(res, {
      message: "无效引用",
      chapters: [
        {
          id: "foreign-book-chapter",
          title: "章",
          content: "正文",
          stage: "complete",
        },
      ],
    }),
  );
  expect((await done(app, await send(app, projectId, "重写"))).status).toBe(
    "failed",
  );
  await app.dispose();
  const store = new Store(join(dir, "works.sqlite"));
  try {
    const files = new ProjectFiles(store),
      path = join(dir, "backup.novel");
    await files.backup(projectId, path);
    await expect(files.importBackup(path)).resolves.toBeTruthy();
  } finally {
    store.close();
  }
});

it("retrying an authorized rewrite retains the concrete approved scope", async () => {
  let call = 0,
    chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) => {
    call++;
    if (call === 2) return reply(res, "malformed JSON");
    reply(res, {
      message: "调整职业",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "调查员",
        stage: "complete",
      })),
    });
  });
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (await done(app, await send(app, projectId, "把主角改成调查员"))).status,
  ).toBe("awaiting-author");
  const failed = await done(app, await send(app, projectId, "一起改"));
  expect(failed.status).toBe("failed");
  const retryId = id(
    await app.dispatch({
      type: "conversation.retry",
      id: failed.id,
    } as Command),
  );
  expect((await done(app, retryId)).status).toBe("completed");
  expect(app.snapshot().chapters.every((c) => c.content === "调查员")).toBe(
    true,
  );
});

it("keeps each completed chapter available when a model includes an already authorized proposal", async () => {
  let target = "";
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "改写完成",
      proposal: { chapterIds: [target], reason: "改写当前章" },
      chapters: [
        { id: target, title: "章", content: "新正文", stage: "complete" },
      ],
    }),
  );
  target = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "章",
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "重写当前章"))).status,
  ).toBe("completed");
  expect(app.snapshot().chapters[0].content).toBe("新正文");
});

it("never adds the selected chapter to an explicitly narrower rewrite scope", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "改写",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "改后",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (
      await done(
        app,
        await send(app, projectId, "只重写第1章", {
          chapterId: chapters[1].id,
        }),
      )
    ).status,
  ).toBe("awaiting-author");
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("does not let an in-scope proposal hide out-of-scope chapter edits", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "改写",
      proposal: { chapterIds: [chapters[1].id], reason: "改当前章" },
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "改后",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (await done(app, await send(app, projectId, "重写当前章"))).status,
  ).toBe("awaiting-author");
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("does not replace an existing note whose full text could not fit", async () => {
  let noteId = "";
  const { app, projectId } = await setup(
    (_body, res) =>
      reply(res, {
        message: "整理人物",
        notes: [
          {
            id: noteId,
            type: "character",
            title: "人物",
            body: "过短且丢失后半设定的替换",
          },
        ],
      }),
    { maxContextChars: 2000 },
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "人物",
      body: "甲".repeat(10000),
      sources: [],
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "整理人物设定"))).status,
  ).toBe("failed");
  expect(app.snapshot().notes[0].body.length).toBe(10000);
});

it("keeps historic note references portable after the author deletes a note", async () => {
  let noteId = "";
  const { app, projectId, dir } = await setup((_body, res) =>
    reply(res, {
      message: "整理人物",
      notes: [{ id: noteId, type: "character", title: "人物", body: "新设定" }],
    }),
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "人物",
      body: "原设定",
      sources: [],
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "整理人物设定"))).status,
  ).toBe("completed");
  id(
    await app.dispatch({
      type: "note.delete",
      id: noteId,
      revision: app.snapshot().notes[0].revision,
    }),
  );
  await app.dispose();
  const store = new Store(join(dir, "works.sqlite"));
  try {
    const files = new ProjectFiles(store),
      path = join(dir, "deleted-note.novel");
    await files.backup(projectId, path);
    await expect(files.importBackup(path)).resolves.toBeTruthy();
  } finally {
    store.close();
  }
});

it("retains prior setting text when AI updates it, and restoration retains the AI version", async () => {
  let noteId = "";
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "已更新职业",
      notes: [
        {
          id: noteId,
          type: "character",
          title: "林舟",
          body: "保险调查员，怕黑",
        },
      ],
    }),
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "林舟",
      body: "遗物整理师，怕黑",
      sources: [],
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "把主角改成调查员"))).status,
  ).toBe("completed");
  const note = app.snapshot().notes[0];
  expect((note as any).history?.[0].body).toBe("遗物整理师，怕黑");
  id(
    await app.dispatch({
      type: "note.save",
      id: note.id,
      revision: note.revision,
      projectId,
      noteType: "character",
      title: "林舟",
      body: "遗物整理师，怕黑",
      sources: [],
    }),
  );
  expect((app.snapshot().notes[0] as any).history?.at(-1).body).toBe(
    "保险调查员，怕黑",
  );
});

it("infers a missing rewrite id from the explicit target instead of a different selected opening", async () => {
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "重写第一章",
      chapters: [{ title: "第一章", content: "新的第一章", stage: "complete" }],
    }),
  );
  const first = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "第一章",
    }),
  );
  const second = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 2,
      title: "第二章",
    }),
  );
  const store = new Store(join(dirs.at(-1)!, "works.sqlite"));
  try {
    const c = store.get("chapters", second)!;
    store.put("chapters", {
      ...c,
      content: "保留第二章开篇",
      writingStage: "opening",
    });
  } finally {
    store.close();
  }
  expect(
    (
      await done(
        app,
        await send(app, projectId, "只重写第1章", { chapterId: second }),
      )
    ).status,
  ).toBe("completed");
  expect(app.snapshot().chapters.find((c) => c.id === first)!.content).toBe(
    "新的第一章",
  );
  expect(app.snapshot().chapters.find((c) => c.id === second)!.content).toBe(
    "保留第二章开篇",
  );
});

it("subtracts explicit excluded chapters from broader rewrite ranges", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "重写",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "不该全部改",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (await done(app, await send(app, projectId, "改全部章节，但别改第1章")))
      .status,
  ).toBe("awaiting-author");
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("does not invalidate manuscript or accumulate setting versions for unchanged model fields", async () => {
  let noteId = "";
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "我们再聊聊",
      project: { background: "" },
      notes: [{ id: noteId, type: "character", title: "人物", body: "原设定" }],
    }),
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "人物",
      body: "原设定",
      sources: [],
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "章",
    }),
  );
  const before = app.snapshot();
  expect((await done(app, await send(app, projectId, "聊聊故事"))).status).toBe(
    "completed",
  );
  expect(app.snapshot().projects).toEqual(before.projects);
  expect(app.snapshot().notes).toEqual(before.notes);
  expect(app.snapshot().chapters).toEqual(before.chapters);
});

it("accepting a one-chapter proposal does not also authorize the selected chapter", async () => {
  let chapters: any[] = [],
    calls = 0;
  const { app, projectId } = await setup((_body, res) => {
    if (++calls === 1)
      return reply(res, {
        message: "只需改第一章",
        proposal: {
          chapterIds: [chapters[0].id],
          reason: "第一章职业描写需要调整",
        },
      });
    reply(res, {
      message: "改写",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "模型越界改写",
        stage: "complete",
      })),
    });
  });
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  const proposal = await done(app, await send(app, projectId, "调整职业"));
  expect(proposal.proposal.chapterIds).toEqual([chapters[0].id]);
  expect(
    (
      await done(
        app,
        await send(app, projectId, "一起改", { proposalTurnId: proposal.id }),
      )
    ).status,
  ).toBe("awaiting-author");
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("accepts an explicit three-chapter batch, but prevents duplicate simultaneous turns", async () => {
  let release!: () => void;
  const { app, projectId } = await setup((_body, res) => {
    release = () =>
      reply(res, {
        message: "三章已写好",
        chapters: [1, 2, 3].map((n) => ({
          title: `章${n}`,
          content: `第${n}章正文`,
          stage: "complete",
        })),
      });
  });
  const turnId = await send(app, projectId, "连写三章");
  expect(
    await app.dispatch({
      type: "conversation.send",
      projectId,
      text: "继续",
    } as Command),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  await expect.poll(() => !!release).toBe(true);
  release();
  expect((await done(app, turnId)).status).toBe("completed");
  expect(app.snapshot().chapters.map((c) => c.ordinal)).toEqual([1, 2, 3]);
});

it("discloses omitted long context and refuses to rewrite an incompletely supplied chapter", async () => {
  let target = "";
  const { app, projectId } = await setup(
    (_body, res) =>
      reply(res, {
        message: "重写",
        chapters: [
          { id: target, title: "长章", content: "不应替换", stage: "complete" },
        ],
      }),
    { maxContextChars: 2000 },
  );
  target = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "长章",
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.save",
      id: target,
      revision: 1,
      content: "甲".repeat(10000),
    }),
  );
  const turn = await done(app, await send(app, projectId, "重写当前章"));
  expect(turn.status).toBe("failed");
  expect(turn.contextWarnings.length).toBeGreaterThan(0);
  expect(app.snapshot().chapters[0].content.length).toBe(10000);
});
