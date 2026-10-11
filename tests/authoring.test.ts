import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppServices } from "../src/main/services";
import { Store } from "../src/main/store";
import { ProjectFiles } from "../src/main/files";
import type { Command, CommandResult } from "../src/shared/types";

const apps: AppServices[] = [],
  dirs: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.dispose()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function id(r: CommandResult) {
  if (!r.ok) throw Error(r.error.message);
  return r.entityId;
}
function setup(handler: (request: any) => unknown | Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "novel-stages-"));
  dirs.push(dir);
  const app = new AppServices({
    dataDir: dir,
    dialogs: { open: async () => null, save: async () => null },
    fetch: async (_url, init) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  await (async () => {
                    const request = JSON.parse(String(init!.body));
                    if (
                      request.messages[0].content.includes(
                        "STAGE_SYNC_NORMALIZE",
                      )
                    ) {
                      const data = JSON.parse(request.messages.at(-1).content);
                      const binding = data.bindings.find(
                        (b: any) => b.kind === "note",
                      );
                      return {
                        stage: data.stage,
                        blocks: [
                          data.stage === "outline"
                            ? {
                                kind: "note",
                                noteType: "outline",
                                title: "故事大纲",
                                ...(binding ? { noteId: binding.noteId } : {}),
                                startLine: 1,
                                endLine: data.lineCount,
                              }
                            : {
                                kind: "field",
                                field:
                                  data.stage === "overview"
                                    ? "background"
                                    : "style",
                                startLine: 1,
                                endLine: data.lineCount,
                              },
                        ],
                        removeNoteIds: [],
                      };
                    }
                    return handler(request);
                  })(),
                ),
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  });
  apps.push(app);
  const projectId = id(
    app.domain.execute({ type: "project.create", title: "阶段小说" }),
  );
  id(
    app.domain.execute({
      type: "profile.save",
      name: "创作",
      baseUrl: "http://127.0.0.1:1234/v1",
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
  const turnId = id(
    await app.dispatch({
      type: "conversation.send",
      projectId,
      text,
      ...extra,
    } as Command),
  );
  await expect
    .poll(
      () => app.snapshot().conversations.find((t) => t.id === turnId)!.status,
    )
    .not.toBe("running");
  return app.snapshot().conversations.find((t) => t.id === turnId)!;
}
function workflow(app: AppServices) {
  return (app.snapshot().projects[0] as any).authoring;
}
const artifact = (stage: string, content = `${stage}完整成果`) => ({
  message: "请看看这个方向",
  artifacts: [{ stage, content }],
});

it("advances exactly one confirmed stage at a time and persists the chain across restart", async () => {
  let count = 0;
  const { app, projectId, dir } = setup((req) => {
    const targets = ["概要", "设定", "大纲", "正文"];
    expect(JSON.stringify(req.messages)).toContain(targets[count]);
    return count++ < 3
      ? artifact(["overview", "settings", "outline"][count - 1])
      : {
          message: "第一章试写",
          chapters: [
            { title: "开头", content: "第一章试写正文", stage: "opening" },
          ],
        };
  });
  expect((await send(app, projectId, "推荐一个悬疑故事")).status).toBe(
    "completed",
  );
  expect(workflow(app).activeStage).toBe("overview");
  expect(workflow(app).documents.overview.approved).toBe(false);
  await send(app, projectId, "按推荐");
  expect(workflow(app).documents.overview.approved).toBe(true);
  expect(workflow(app).activeStage).toBe("settings");
  await send(app, projectId, "继续");
  expect(workflow(app).documents.settings.approved).toBe(true);
  expect(workflow(app).activeStage).toBe("outline");
  await send(app, projectId, "继续");
  expect(workflow(app).documents.outline.approved).toBe(true);
  expect(workflow(app).activeStage).toBe("writing");
  expect(app.snapshot().chapters[0].content).toBe("第一章试写正文");
  const expected = workflow(app);
  await app.dispose();
  const reopened = new AppServices({
    dataDir: dir,
    dialogs: { open: async () => null, save: async () => null },
  });
  apps.push(reopened);
  expect(workflow(reopened)).toEqual(expected);
});

it("keeps planning progress during an early sample and bare continue returns to planning", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    ++calls === 1
      ? {
          message: "试写",
          chapters: [{ title: "开篇", content: "试写正文", stage: "opening" }],
        }
      : artifact("overview"),
  );
  expect((await send(app, projectId, "先试写一段")).status).toBe("completed");
  expect(workflow(app).activeStage).toBe("overview");
  await send(app, projectId, "继续");
  expect(workflow(app).documents.overview.approved).toBe(false);
  expect(app.snapshot().chapters).toHaveLength(1);
});

it("does not let an ordinary message or empty-stage continue skip ahead into prose", async () => {
  const { app, projectId } = setup(() => ({
    message: "越过规划",
    artifacts: [{ stage: "outline", content: "未经授权的大纲" }],
    chapters: [{ title: "正文", content: "越界正文", stage: "complete" }],
  }));
  expect((await send(app, projectId, "继续")).status).toBe("failed");
  expect(app.snapshot().chapters).toHaveLength(0);
  expect(workflow(app)).toBeUndefined();
});

it("delegates settings and outline together without granting prose authorization", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    ++calls === 1
      ? artifact("overview")
      : {
          message: "设定和大纲准备好了",
          artifacts: [
            { stage: "settings", content: "人物关系" },
            { stage: "outline", content: "全书转折及前三章" },
          ],
        },
  );
  await send(app, projectId, "想写悬疑");
  expect((await send(app, projectId, "后面的设定和大纲你来定")).status).toBe(
    "completed",
  );
  expect(workflow(app).documents.overview.approved).toBe(true);
  expect(workflow(app).documents.settings.content).toBe("人物关系");
  expect(workflow(app).activeStage).toBe("outline");
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("manual upstream edits preserve history, invalidate downstream approvals and protect manuscript", async () => {
  let count = 0;
  const { app, projectId } = setup(() =>
    artifact(["overview", "settings", "outline"][count++]),
  );
  await send(app, projectId, "想写悬疑");
  await send(app, projectId, "继续");
  await send(app, projectId, "继续");
  const before = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: before.revision,
      stage: "overview",
      content: "新的核心冲突和结局",
    } as Command),
  );
  expect(workflow(app).activeStage).toBe("overview");
  expect(workflow(app).documents.overview.history[0].content).toBe(
    "overview完整成果",
  );
  expect(workflow(app).documents.settings.needsReview).toBe(true);
  expect(workflow(app).documents.settings.approved).toBe(false);
  expect(workflow(app).documents.outline.needsReview).toBe(true);
  expect(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: before.revision,
      stage: "overview",
      content: "过时编辑",
    } as Command),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
});

it("reconciles changed upstream documents as one review group without editing written chapters", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    ++calls <= 3
      ? artifact(["overview", "settings", "outline"][calls - 1])
      : calls === 4
        ? {
            message: "已同步故事主线、人物动机和后续大纲",
            artifacts: ["overview", "settings", "outline"].map((stage) => ({
              stage,
              content: `${stage}调整后`,
            })),
          }
        : {
            message: "开始试写",
            chapters: [
              { title: "首章", content: "新方向的试写", stage: "opening" },
            ],
          },
  );
  await send(app, projectId, "构思故事");
  await send(app, projectId, "继续");
  await send(app, projectId, "继续");
  expect(
    (
      await send(app, projectId, "修改概要，把寻亲改成调查骗局", {
        stage: "overview",
      })
    ).status,
  ).toBe("completed");
  expect(workflow(app).reviewGroup).toEqual([
    "overview",
    "settings",
    "outline",
  ]);
  expect(app.snapshot().chapters).toHaveLength(0);
  await send(app, projectId, "继续");
  expect(workflow(app).activeStage).toBe("writing");
  expect(
    Object.values(workflow(app).documents).every((d: any) => d.approved),
  ).toBe(true);
});

it("cancellation and invalid responses do not consume a stage confirmation", async () => {
  let calls = 0,
    release!: () => void;
  const { app, projectId } = setup(async () => {
    if (++calls === 1) return artifact("overview");
    await new Promise<void>((r) => {
      release = r;
    });
    return artifact("settings");
  });
  await send(app, projectId, "写概要");
  const turnId = id(
    await app.dispatch({
      type: "conversation.send",
      projectId,
      text: "继续",
    } as Command),
  );
  await expect.poll(() => !!release).toBe(true);
  id(await app.dispatch({ type: "conversation.cancel", id: turnId }));
  release();
  await expect
    .poll(() => app.snapshot().conversations.at(-1)!.status)
    .toBe("cancelled");
  expect(workflow(app).activeStage).toBe("overview");
  expect(workflow(app).documents.overview.approved).toBe(false);
});

it("legacy manuscript continues without restarting planning and stage artifacts survive portable backup", async () => {
  let target = "";
  const { app, projectId, dir } = setup(() => ({
    message: "继续本章并补齐规划",
    artifacts: ["overview", "settings", "outline"].map((stage) => ({
      stage,
      content: `从现有正文整理的${stage}`,
    })),
    chapters: [
      { id: target, title: "旧章", content: "旧稿接着写", stage: "complete" },
    ],
  }));
  target = id(
    app.domain.execute({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "旧章",
    }),
  );
  id(
    app.domain.execute({
      type: "chapter.save",
      id: target,
      revision: 1,
      content: "旧稿",
    }),
  );
  expect((await send(app, projectId, "继续")).status).toBe("completed");
  expect(workflow(app).activeStage).toBe("writing");
  const expected = workflow(app);
  await app.dispose();
  const store = new Store(join(dir, "works.sqlite"));
  try {
    const files = new ProjectFiles(store),
      path = join(dir, "stages.novel");
    await files.backup(projectId, path);
    const copy = await files.importBackup(path);
    const imported = (
      store.snapshot().projects.find((p) => p.id === copy) as any
    ).authoring;
    const stripReferences = (value: any): any =>
      Array.isArray(value)
        ? value.map(stripReferences)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .filter(
                  ([key]) =>
                    !["id", "noteId", "jobId", "batchId"].includes(key),
                )
                .map(([key, item]) => [key, stripReferences(item)]),
            )
          : value;
    expect(stripReferences(imported)).toEqual(stripReferences(expected));
    for (const stage of ["overview", "settings", "outline"]) {
      for (const binding of imported.documents[stage]?.sync?.bindings ?? [])
        if (binding.noteId)
          expect(
            store
              .snapshot()
              .notes.some(
                (n) => n.id === binding.noteId && n.projectId === copy,
              ),
          ).toBe(true);
      expect(
        store
          .snapshot()
          .syncJobs.some(
            (j) =>
              j.id === imported.documents[stage]?.sync?.jobId &&
              j.projectId === copy,
          ),
      ).toBe(true);
    }
    const pack = JSON.parse(readFileSync(path, "utf8"));
    pack.payload.projects[0].authoring.activeStage = "invented";
    pack.sha256 = createHash("sha256")
      .update(JSON.stringify(pack.payload))
      .digest("hex");
    writeFileSync(path, JSON.stringify(pack));
    await expect(files.importBackup(path)).rejects.toThrow();
  } finally {
    store.close();
  }
});

it("keeps legacy books with more than 30000 characters of settings usable without truncating source notes", async () => {
  const { app, projectId } = setup(() => ({
    message: "下一章",
    chapters: [{ title: "新章", content: "继续原故事", stage: "complete" }],
  }));
  for (const title of ["人物甲", "人物乙"])
    id(
      app.domain.execute({
        type: "note.save",
        projectId,
        noteType: "character",
        title,
        body: "甲".repeat(16000),
        sources: [],
      }),
    );
  id(
    app.domain.execute({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "已有章节",
    }),
  );
  expect((await send(app, projectId, "继续")).status).toBe("completed");
  expect(app.snapshot().notes.every((n) => n.body.length === 16000)).toBe(true);
});

it("respects a delegated end stage and rejects omitted intermediate artifacts", async () => {
  let output: any = {
    message: "概要和设定",
    artifacts: ["overview", "settings"].map((stage) => ({
      stage,
      content: stage,
    })),
  };
  const { app, projectId } = setup(() => output);
  expect(
    (await send(app, projectId, "先把概要和设定一起完成，大纲等我确认后再做"))
      .status,
  ).toBe("completed");
  expect(workflow(app).activeStage).toBe("settings");
  expect(workflow(app).documents.outline).toBeUndefined();
  const other = id(
    app.domain.execute({ type: "project.create", title: "另一部" }),
  );
  output = {
    message: "只给大纲",
    artifacts: [{ stage: "outline", content: "漏掉前面" }],
  };
  expect((await send(app, other, "前期规划你来定，全部完成")).status).toBe(
    "failed",
  );
  expect(
    app.snapshot().projects.find((p) => p.id === other)!.authoring,
  ).toBeUndefined();
});

it("manual future-stage drafts do not let bare continue silently bypass missing prerequisites", async () => {
  const { app, projectId } = setup(() => artifact("overview"));
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: 1,
      stage: "outline",
      content: "作者先记下的大纲",
    } as Command),
  );
  expect((await send(app, projectId, "继续")).status).toBe("completed");
  expect(workflow(app).activeStage).toBe("overview");
  expect(workflow(app).documents.overview.approved).toBe(false);
});

it("editing an early sample through the prose tab does not approve or discard planning", async () => {
  let target = "";
  const { app, projectId } = setup(() => ({
    message: "试写调整",
    chapters: [
      {
        ...(target ? { id: target } : {}),
        title: "试写",
        content: "试写正文",
        stage: "opening",
      },
    ],
  }));
  await send(app, projectId, "先试写一段");
  target = app.snapshot().chapters[0].id;
  expect(
    (await send(app, projectId, "节奏快一点", { stage: "writing" })).status,
  ).toBe("completed");
  expect(workflow(app).activeStage).toBe("overview");
});

it("merely selecting a future tab does not authorize skipping the default stage", async () => {
  let output: any = {
    message: "越过概要",
    artifacts: [{ stage: "outline", content: "跳级大纲" }],
  };
  const { app, projectId } = setup(() => output);
  expect(
    (await send(app, projectId, "我想写悬疑", { stage: "outline" })).status,
  ).toBe("failed");
  output = {
    message: "越过规划",
    chapters: [{ title: "章", content: "跳级正文", stage: "complete" }],
  };
  expect(
    (await send(app, projectId, "我想写悬疑", { stage: "writing" })).status,
  ).toBe("failed");
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("delegated upstream rewrites cannot approve an unaccepted outline or generate prose", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    ++calls <= 3
      ? artifact(["overview", "settings", "outline"][calls - 1])
      : {
          message: "错误跳到正文",
          chapters: [{ title: "章", content: "不应写入", stage: "complete" }],
        },
  );
  await send(app, projectId, "构思故事");
  await send(app, projectId, "继续");
  await send(app, projectId, "继续");
  const before = workflow(app);
  expect((await send(app, projectId, "重写概要和设定，你来定")).status).toBe(
    "failed",
  );
  expect(workflow(app)).toEqual(before);
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("delegating planning on an existing manuscript stays within planning and then resumes writing", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    ++calls === 1
      ? {
          message: "已整理规划",
          artifacts: [
            { stage: "settings", content: "更新设定" },
            { stage: "outline", content: "后续大纲" },
          ],
        }
      : {
          message: "继续正文",
          chapters: [
            { title: "第二章", content: "旧书接续正文", stage: "complete" },
          ],
        },
  );
  id(
    app.domain.execute({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "已有第一章",
    }),
  );
  expect((await send(app, projectId, "后面的设定和大纲你来定")).status).toBe(
    "completed",
  );
  expect(workflow(app).activeStage).toBe("outline");
  expect(app.snapshot().chapters).toHaveLength(1);
  expect((await send(app, projectId, "继续")).status).toBe("completed");
  expect(workflow(app).activeStage).toBe("writing");
  expect(app.snapshot().chapters).toHaveLength(2);
});

it("accepts natural short confirmations but keeps mixed approval and revision requests in the same stage", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    artifact(
      ++calls === 1 ? "overview" : "settings",
      calls === 3 ? "修改后的设定" : "完整推荐成果",
    ),
  );
  await send(app, projectId, "构思一个故事");
  expect((await send(app, projectId, "对，是的。")).status).toBe("completed");
  expect(workflow(app).activeStage).toBe("settings");
  expect((await send(app, projectId, "可以，但先改一下设定")).status).toBe(
    "completed",
  );
  expect(workflow(app).activeStage).toBe("settings");
  expect(workflow(app).documents.settings.approved).toBe(false);
  expect(workflow(app).documents.settings.content).toBe("修改后的设定");
});

it("uses the earliest named upstream stage when multiple planning stages are mentioned", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    ++calls <= 3
      ? artifact(["overview", "settings", "outline"][calls - 1])
      : {
          message: "同步修改",
          artifacts: ["overview", "settings", "outline"].map((stage) => ({
            stage,
            content: `更新后的${stage}`,
          })),
        },
  );
  await send(app, projectId, "构思故事");
  await send(app, projectId, "继续");
  await send(app, projectId, "继续");
  expect((await send(app, projectId, "修改概要和设定")).status).toBe(
    "completed",
  );
  expect(workflow(app).activeStage).toBe("overview");
  expect(workflow(app).reviewGroup).toEqual([
    "overview",
    "settings",
    "outline",
  ]);
});

it("the return-to-planning suggestion exits preview context without approving an empty plan", async () => {
  let calls = 0;
  const { app, projectId } = setup(() =>
    ++calls === 1
      ? {
          message: "试写好了",
          chapters: [{ title: "试写", content: "试写正文", stage: "opening" }],
        }
      : artifact("overview"),
  );
  await send(app, projectId, "先试写一段");
  expect(
    (await send(app, projectId, "回到规划，继续", { stage: "writing" })).status,
  ).toBe("completed");
  expect(workflow(app).activeStage).toBe("overview");
  expect(workflow(app).documents.overview.approved).toBe(false);
  expect(app.snapshot().chapters).toHaveLength(1);
});
