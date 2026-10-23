import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppServices } from "./support/test-app";
import type { CommandResult } from "../src/shared/types";
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
it("backs up reading annotations, review baselines and volumes with remapped identities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-files-"));
  dirs.push(directory);
  const path = join(directory, "book.novel");
  const app = new AppServices({
    dataDir: directory,
    dialogs: { open: async () => path, save: async () => path },
  });
  apps.push(app);
  const projectId = id(
    await app.dispatch({ type: "project.create", title: "长篇备份" }),
  );
  const chapterId = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "起点",
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.save",
      id: chapterId,
      revision: 1,
      content: "第一段\n第二段",
    }),
  );
  expect(app.chapter(chapterId).contentHash).toBe(
    createHash("sha256").update("第一段\n第二段").digest("hex"),
  );
  id(
    await app.dispatch({
      type: "reading.annotate",
      projectId,
      selection: { chapterId, revision: 2, start: 0, end: 3, quote: "第一段" },
      text: "细化这里",
    }),
  );
  id(
    await app.dispatch({
      type: "reading.review",
      projectId,
      chapterId,
      revision: 2,
    }),
  );
  id(
    await app.dispatch({
      type: "reading.volumeSave",
      projectId,
      title: "第一卷",
      fromOrdinal: 1,
      toOrdinal: 1,
    }),
  );
  id(
    await app.dispatch({
      type: "reading.position",
      projectId,
      chapterId,
      offset: 4,
      mode: "review",
    }),
  );
  id(await app.dispatch({ type: "file.backup", projectId }));
  const imported = id(await app.dispatch({ type: "file.importBackup" }));
  const state = app.snapshot();
  const copyChapter = state.chapters.find((c) => c.projectId === imported)!;
  const workspace = state.readingWorkspaces!.find(
    (w) => w.projectId === imported,
  )!;
  expect(workspace.annotations[0].chapterId).toBe(copyChapter.id);
  expect(workspace.annotations[0].anchor.chapterId).toBe(copyChapter.id);
  expect(workspace.annotations[0].id).not.toBe(
    state.readingWorkspaces!.find((w) => w.projectId === projectId)!
      .annotations[0].id,
  );
  expect(workspace.reviews[0].chapterId).toBe(copyChapter.id);
  expect(
    state.versions.find((v) => v.id === workspace.reviews[0].versionId)
      ?.chapterId,
  ).toBe(copyChapter.id);
  expect(workspace.position).toMatchObject({
    chapterId: copyChapter.id,
    offset: 4,
    mode: "review",
  });
  expect(workspace.volumes[0].title).toBe("第一卷");
});
it("imports an annotation made at an invalidation-only revision after later prose edits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-anchor-"));
  dirs.push(directory);
  const path = join(directory, "book.novel");
  const app = new AppServices({
    dataDir: directory,
    dialogs: { open: async () => path, save: async () => path },
  });
  apps.push(app);
  const projectId = id(
    await app.dispatch({ type: "project.create", title: "原文基准" }),
  );
  const first = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "甲",
    }),
  );
  const second = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 2,
      title: "乙",
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.save",
      id: second,
      revision: 1,
      content: "旧正文",
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.save",
      id: first,
      revision: 1,
      content: "上游改动",
    }),
  );
  const revision = app.chapter(second).revision;
  id(
    await app.dispatch({
      type: "reading.annotate",
      projectId,
      selection: {
        chapterId: second,
        revision,
        start: 0,
        end: 3,
        quote: "旧正文",
      },
      text: "待调整",
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.save",
      id: second,
      revision,
      content: "新正文",
    }),
  );
  id(await app.dispatch({ type: "file.backup", projectId }));
  const imported = id(await app.dispatch({ type: "file.importBackup" }));
  expect(
    app.snapshot().readingWorkspaces!.find((w) => w.projectId === imported)!
      .annotations[0].anchor.quote,
  ).toBe("旧正文");
});
it("can adopt pending candidates and resume paused jobs restored as a renamed copy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-revision-copy-"));
  dirs.push(directory);
  const path = join(directory, "book.novel");
  const app = new AppServices({
    dataDir: directory,
    dialogs: { open: async () => path, save: async () => path },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)),
        chapter = JSON.parse(body.messages.at(-1).content).chapter;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  message: "完成检查",
                  chapters: [
                    {
                      id: chapter.id,
                      title: chapter.title,
                      content: "待审改稿",
                      stage: "complete",
                    },
                  ],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            total_tokens: 200,
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  apps.push(app);
  const projectId = id(
    await app.dispatch({ type: "project.create", title: "待审稿副本" }),
  );
  id(
    await app.dispatch({
      type: "profile.save", pricing: { currency: "CNY", input: 0, output: 0 },
      name: "改稿模型",
      baseUrl: "http://localhost/v1",
      model: "fixture",
      purpose: "writing",
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
  const pending = id(
    await app.dispatch({
      type: "revision.start",
      projectId,
      scope: "all",
      text: "全书改稿",
      tokenBudget: 30000,
    }),
  );
  await expect
    .poll(
      () => app.snapshot().revisionJobs!.find((j) => j.id === pending)?.status,
    )
    .toBe("awaiting-author");
  id(await app.dispatch({ type: "file.backup", projectId }));
  const copy = id(await app.dispatch({ type: "file.importBackup" }));
  const copiedJob = app
    .snapshot()
    .revisionJobs!.find((j) => j.projectId === copy)!;
  id(await app.dispatch({ type: "revision.accept", id: copiedJob.id }));
  expect(
    app
      .snapshot()
      .chapters.filter((c) => c.projectId === copy)
      .every((c) => c.content === "待审改稿"),
  ).toBe(true);
  const paused = id(
    await app.dispatch({
      type: "revision.start",
      projectId,
      scope: "all",
      text: "再次检查",
      tokenBudget: 1,
    }),
  );
  await expect
    .poll(
      () => app.snapshot().revisionJobs!.find((j) => j.id === paused)?.status,
    )
    .toBe("paused");
  id(await app.dispatch({ type: "file.backup", projectId }));
  const secondCopy = id(await app.dispatch({ type: "file.importBackup" }));
  const copiedPaused = app
    .snapshot()
    .revisionJobs!.find(
      (j) => j.projectId === secondCopy && j.status === "paused",
    )!;
  id(
    await app.dispatch({
      type: "revision.resume",
      id: copiedPaused.id,
      tokenBudget: 30000,
    }),
  );
  await expect
    .poll(
      () =>
        app.snapshot().revisionJobs!.find((j) => j.id === copiedPaused.id)
          ?.status,
    )
    .toBe("awaiting-author");
});
