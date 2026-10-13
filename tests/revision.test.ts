import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { RevisionRunner, detectRevisionRequest } from "../src/main/revision";
import type { ChatProvider, ChatRequest } from "../src/main/provider";
import { validateRevisionJob } from "../src/shared/revision";
const stores: Store[] = [],
  runners: RevisionRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.dispose()));
  stores.splice(0).forEach((s) => s.close());
});
function setup(
  handler: (r: ChatRequest) => Promise<string> | string,
  maxChars?: number,
) {
  const store = new Store(":memory:");
  stores.push(store);
  const domain = new DomainService(store);
  const execute = (c: any) => {
    const r = domain.execute(c);
    if (!r.ok) throw Error(r.error.message);
    return r.entityId;
  };
  const projectId = execute({ type: "project.create", title: "故事" });
  execute({
    type: "profile.save",
    name: "模型",
    baseUrl: "http://localhost/v1",
    model: "fixture",
    purpose: "writing",
  });
  const chapters = ["左。重复。中。重复。右。", "第二章正文", "第三章正文"].map(
    (content, i) => {
      const id = execute({
        type: "chapter.create",
        projectId,
        ordinal: i + 1,
        title: `章${i + 1}`,
      });
      execute({ type: "chapter.save", id, revision: 1, content });
      return store.get("chapters", id)!;
    },
  );
  const provider = {
    complete: async (r: ChatRequest) => {
      r.onAttempt?.();
      return {
        text: await handler(r),
        usage: {
          inputTokens: 100,
          outputTokens: 100,
          totalTokens: 200,
          estimated: false,
        },
      };
    },
  } as ChatProvider;
  const runner = new RevisionRunner(
    store,
    domain,
    provider,
    undefined,
    undefined,
    maxChars,
  );
  runners.push(runner);
  return { store, domain, execute, projectId, chapters, runner, provider };
}
async function done(r: RevisionRunner, id: string) {
  await expect.poll(() => r.get(id).status).not.toBe("running");
  return r.get(id);
}
function target(r: ChatRequest) {
  return JSON.parse(r.messages.at(-1)!.content).chapter;
}
const changed = (r: ChatRequest) =>
  JSON.stringify({
    message: "修改完成",
    chapters: [
      {
        id: target(r).id,
        title: target(r).title,
        content: "改后正文",
        stage: "complete",
      },
    ],
  });
it("replaces exactly the selected duplicate quotation and retains history", async () => {
  const { runner, store, projectId, chapters } = setup(() =>
    JSON.stringify({ message: "改好了", replacement: "新片段" }),
  );
  const c = chapters[0],
    start = c.content.lastIndexOf("重复");
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "selection",
    text: "修改所选片段",
    selection: {
      chapterId: c.id,
      revision: c.revision,
      start,
      end: start + 2,
      quote: "重复",
    },
    tokenBudget: 20000,
  });
  expect((await done(runner, id)).status).toBe("completed");
  expect(store.get("chapters", c.id)!.content).toBe(
    "左。重复。中。新片段。右。",
  );
  expect(store.chapterVersions(c.id).length).toBeGreaterThan(2);
});
it("keeps multi-chapter candidates durable and accepts across invalidation-only revisions", async () => {
  const { runner, store, projectId, chapters } = setup(changed);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "chapters",
    chapterIds: chapters.map((c) => c.id),
    text: "统一修改",
    tokenBudget: 30000,
  });
  const j = await done(runner, id);
  expect(j.status).toBe("awaiting-author");
  expect(j.checkedChapterIds).toHaveLength(3);
  expect(j.usage!.estimated).toBe(false);
  expect(store.get("chapters", chapters[0].id)!.content).toBe(
    chapters[0].content,
  );
  runner.command({ type: "revision.accept", id, chapterIds: [chapters[0].id] });
  runner.command({
    type: "revision.accept",
    id,
    chapterIds: [chapters[1].id, chapters[2].id],
  });
  expect(chapters.map((c) => store.get("chapters", c.id)!.content)).toEqual([
    "改后正文",
    "改后正文",
    "改后正文",
  ]);
});
it("atomically refuses all adoption if one source was manually changed", async () => {
  const { runner, store, execute, projectId, chapters } = setup(changed);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "统一修改",
    tokenBudget: 30000,
  });
  await done(runner, id);
  const c = store.get("chapters", chapters[2].id)!;
  execute({
    type: "chapter.save",
    id: c.id,
    revision: c.revision,
    content: "作者手改",
  });
  expect(() => runner.command({ type: "revision.accept", id })).toThrow(
    /变化|修改|冲突/,
  );
  expect(store.get("chapters", chapters[0].id)!.content).toBe(
    chapters[0].content,
  );
});
it("refuses a writing proposal when planning content changed without changing project fields", async () => {
  const { runner, store, projectId, chapters } = setup(changed);
  const project = store.get("projects", projectId)!;
  project.authoring = {
    activeStage: "writing",
    documents: {
      outline: { content: "主角最终救回妹妹。", revision: 1, approved: true, needsReview: false, history: [] },
    },
  };
  store.put("projects", project);
  const id = runner.start({ type: "revision.start", projectId, scope: "chapters", chapterIds: [chapters[0].id], text: "修改首章", tokenBudget: 30000 });
  const job = await done(runner, id);
  const sourceAuthoringDigest = createHash("sha256").update(JSON.stringify(
    Object.entries(project.authoring.documents).map(([stage, doc]) => [stage, doc.content, doc.approved, doc.needsReview]),
  )).digest("hex");
  store.put("revisionJobs", { ...job, sourceAuthoringDigest });
  store.put("projects", {
    ...project,
    revision: project.revision + 1,
    authoring: {
      ...project.authoring,
      documents: {
        outline: { ...project.authoring.documents.outline!, content: "妹妹早已离开，主角只找回一封旧信。", revision: 2 },
      },
    },
  });
  expect(() => runner.command({ type: "revision.accept", id })).toThrow(/阶段规划已修改/);
  expect(store.get("chapters", chapters[0].id)!.content).toBe(chapters[0].content);
  expect(runner.get(id).candidates[0].status).toBe("pending");
});
it("validates an optional planning-source digest without invalidating legacy revision jobs", async () => {
  const { runner, projectId } = setup(changed);
  const id = runner.start({ type: "revision.start", projectId, scope: "all", text: "统一修改", tokenBudget: 30000 });
  const job = await done(runner, id);
  expect(() => validateRevisionJob(job)).not.toThrow();
  expect(() => validateRevisionJob({ ...job, sourceAuthoringDigest: "a".repeat(64) })).not.toThrow();
  for (const digest of [null, 123, "", "a".repeat(63), "a".repeat(65), "g".repeat(64), "a".repeat(64) + "\n"])
    expect(() => validateRevisionJob({ ...job, sourceAuthoringDigest: digest })).toThrow();
});
it("does not overwrite a source changed while selection generation was running", async () => {
  let release!: (s: string) => void;
  const { runner, store, execute, projectId, chapters } = setup(
    () => new Promise((r) => (release = r)),
  );
  const c = chapters[0];
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "selection",
    text: "改",
    selection: {
      chapterId: c.id,
      revision: c.revision,
      start: 0,
      end: 1,
      quote: "左",
    },
    tokenBudget: 20000,
  });
  await expect.poll(() => !!release).toBe(true);
  execute({
    type: "chapter.save",
    id: c.id,
    revision: c.revision,
    content: "作者手稿",
  });
  release(JSON.stringify({ message: "改", replacement: "新" }));
  expect((await done(runner, id)).status).toBe("failed");
  expect(store.get("chapters", c.id)!.content).toBe("作者手稿");
});
it("pauses without losing checkpoints, resumes without duplicated checked chapters, and does not auto resume after restart", async () => {
  let calls = 0;
  const { runner, store, domain, provider, projectId } = setup((r) => {
    calls++;
    return changed(r);
  });
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "逐章改",
    tokenBudget: 1,
  });
  expect((await done(runner, id)).status).toBe("paused");
  expect(calls).toBe(0);
  runner.command({ type: "revision.resume", id, tokenBudget: 30000 });
  await done(runner, id);
  expect(calls).toBe(3);
  await runner.dispose();
  const reloaded = new RevisionRunner(store, domain, provider);
  runners.push(reloaded);
  expect(reloaded.get(id).candidates).toHaveLength(3);
  expect(calls).toBe(3);
});
it("does not apply linked materials to a rejected or pending partial batch", async () => {
  const { runner, projectId, chapters, store } = setup((r) =>
    JSON.stringify({
      message: "改",
      project: { background: "新设定" },
      chapters: [
        {
          id: target(r).id,
          title: target(r).title,
          content: "改后",
          stage: "complete",
        },
      ],
    }),
  );
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "chapters",
    chapterIds: chapters.slice(0, 2).map((c) => c.id),
    text: "改",
    tokenBudget: 30000,
  });
  await done(runner, id);
  expect(() =>
    runner.command({
      type: "revision.accept",
      id,
      chapterIds: [chapters[0].id],
      includeMaterials: true,
    }),
  ).toThrow();
  runner.command({ type: "revision.reject", id, chapterIds: [chapters[1].id] });
  runner.command({ type: "revision.accept", id, chapterIds: [chapters[0].id] });
  expect(() =>
    runner.command({ type: "revision.accept", id, includeMaterials: true }),
  ).toThrow();
  expect(store.get("projects", projectId)!.background).toBe("");
});
it("treats a question as ambiguity and does not claim that chapter was checked or changed", async () => {
  const { runner, projectId } = setup(() =>
    JSON.stringify({ message: "主角是否知道真相？" }),
  );
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "统一修改",
    tokenBudget: 30000,
  });
  const j = await done(runner, id);
  expect(j.status).toBe("awaiting-author");
  expect(j.checkedChapterIds).toEqual([]);
  expect(j.candidates).toEqual([]);
});
it("checks every chapter separately with bounded context and reports unchanged explicitly", async () => {
  const prompts: string[] = [];
  const { runner, projectId } = setup((r) => {
    prompts.push(r.messages.at(-1)!.content);
    return JSON.stringify({ message: "已检查，无需修改", chapters: [] });
  }, 4000);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "全书检查",
    tokenBudget: 30000,
  });
  const j = await done(runner, id);
  expect(j.checkedChapterIds).toHaveLength(3);
  expect(j.candidates).toEqual([]);
  expect(prompts).toHaveLength(3);
  expect(prompts.every((p) => p.length <= 4000)).toBe(true);
});
it("validates command scope, foreign chapter ids and selected source revision", () => {
  const { runner, projectId, chapters } = setup(changed);
  expect(() =>
    runner.start({
      type: "revision.start",
      projectId,
      scope: "chapter",
      chapterIds: ["foreign"],
      text: "改",
      tokenBudget: 20000,
    }),
  ).toThrow();
  expect(() =>
    runner.start({
      type: "revision.start",
      projectId,
      scope: "selection",
      selection: {
        chapterId: chapters[0].id,
        revision: 1,
        start: 0,
        end: 1,
        quote: "左",
      },
      text: "改",
      tokenBudget: 20000,
    }),
  ).toThrow();
});
it("detects explicit all or multi rewrite requests without diverting ordinary creation", () => {
  const { store, projectId, chapters } = setup(changed);
  expect(
    detectRevisionRequest(
      {
        type: "conversation.send",
        projectId,
        text: "把前两章一起改成轻松一点",
      },
      store,
    )?.chapterIds,
  ).toEqual(chapters.slice(0, 2).map((c) => c.id));
  expect(
    detectRevisionRequest(
      { type: "conversation.send", projectId, text: "连写三章" },
      store,
    ),
  ).toBeNull();
});
it("computes bounded paragraph differences and rejects malformed backup revision records", async () => {
  const { paragraphDiff, validateRevisionJob } =
    await import("../src/shared/revision");
  expect(paragraphDiff("相同\n\n旧段\n\n结尾", "相同\n\n新段\n\n结尾")).toEqual(
    [
      { kind: "same", text: "相同" },
      { kind: "removed", text: "旧段" },
      { kind: "added", text: "新段" },
      { kind: "same", text: "结尾" },
    ],
  );
  expect(() =>
    validateRevisionJob({ id: "x", scope: "all", status: "running" }),
  ).toThrow();
});
it("routes named multi-chapter rewrites and rejects malformed routing DTOs", () => {
  const { store, projectId, chapters } = setup(changed);
  expect(
    detectRevisionRequest(
      { type: "conversation.send", projectId, text: "修改第1章和第2章" },
      store,
    )?.chapterIds,
  ).toEqual(chapters.slice(0, 2).map((c) => c.id));
  expect(() =>
    detectRevisionRequest(
      { type: "conversation.send", projectId, text: undefined } as any,
      store,
    ),
  ).toThrow(/格式/);
  expect(() =>
    detectRevisionRequest(
      {
        type: "conversation.send",
        projectId,
        text: "修改",
        annotationIds: "fake",
      } as any,
      store,
    ),
  ).toThrow(/格式/);
});
it("preserves earlier candidates when a retry exhausts the reserved budget and resumes only unchecked chapters", async () => {
  let requests = 0;
  const { runner, projectId } = setup((r) => {
    requests++;
    if (target(r).title === "章2") r.onAttempt?.();
    return changed(r);
  });
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "修改",
    tokenBudget: 5000,
  });
  let j = await done(runner, id);
  expect(j.status).toBe("paused");
  expect(j.candidates).toHaveLength(1);
  expect(j.calls).toBe(2);
  expect(j.usage!.totalTokens).toBeLessThanOrEqual(5000);
  runner.command({ type: "revision.resume", id, tokenBudget: 30000 });
  j = await done(runner, id);
  expect(j.checkedChapterIds).toHaveLength(3);
  expect(j.candidates).toHaveLength(3);
  expect(requests).toBe(4);
});
it("accepts a real ambiguity answer on the same durable job", async () => {
  let calls = 0;
  const { runner, projectId, chapters } = setup((r) =>
    ++calls === 1
      ? JSON.stringify({ message: "主角是否知道真相？" })
      : changed(r),
  );
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "chapters",
    chapterIds: chapters.slice(0, 2).map((c) => c.id),
    text: "修改",
    tokenBudget: 30000,
  });
  await done(runner, id);
  expect(() => runner.command({ type: "revision.resume", id })).toThrow(/回答/);
  runner.command({ type: "revision.resume", id, text: "主角知道真相" });
  const j = await done(runner, id);
  expect(j.checkedChapterIds).toHaveLength(2);
  expect(j.text).toContain("主角知道真相");
});
it("retains a late cancelled response's usage without saving prose or losing earlier candidates", async () => {
  let release!: (s: string) => void;
  const { runner, projectId, store, chapters } = setup((r) =>
    target(r).title === "章1"
      ? changed(r)
      : new Promise((resolve) => (release = resolve)),
  );
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "修改",
    tokenBudget: 30000,
  });
  await expect.poll(() => !!release).toBe(true);
  runner.command({ type: "revision.cancel", id });
  release(JSON.stringify({ message: "迟到", chapters: [] }));
  await expect.poll(() => runner.get(id).usage?.totalTokens).toBe(400);
  expect(runner.get(id).status).toBe("cancelled");
  expect(runner.get(id).candidates).toHaveLength(1);
  expect(store.get("chapters", chapters[0].id)!.content).toBe(
    chapters[0].content,
  );
});
it("refuses to switch model configurations or use protected keys without a codec", async () => {
  const { runner, projectId, store, execute } = setup(changed);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "修改",
    tokenBudget: 1,
  });
  await done(runner, id);
  const p = store.list("profiles")[0];
  execute({
    type: "profile.save",
    id: p.id,
    revision: p.revision,
    name: p.name,
    baseUrl: p.baseUrl,
    model: "different",
    purpose: p.purpose,
  });
  expect(() =>
    runner.command({ type: "revision.resume", id, tokenBudget: 30000 }),
  ).toThrow(/模型配置/);
  store.setProfileKey(p.id, new Uint8Array([1, 2]));
  expect(() =>
    runner.start({
      type: "revision.start",
      projectId,
      scope: "all",
      text: "修改",
      tokenBudget: 30000,
    }),
  ).toThrow(/密钥/);
});
it("rejects tampered selection responses that return whole chapter operations", async () => {
  const { runner, projectId, chapters } = setup(changed);
  const c = chapters[0];
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "selection",
    text: "修改",
    selection: {
      chapterId: c.id,
      revision: c.revision,
      start: 0,
      end: 1,
      quote: "左",
    },
    tokenBudget: 30000,
  });
  expect((await done(runner, id)).status).toBe("failed");
});
it("checks linked note proposals without applying them until all candidates and materials are accepted", async () => {
  let noteId = "",
    sawPending = false;
  const { runner, projectId, execute, store } = setup((r) => {
    const data = JSON.parse(r.messages.at(-1)!.content);
    if (target(r).title === "章2")
      sawPending = data.plannedChanges.notes[0].body === "新人物设定";
    return JSON.stringify({
      message: "修改",
      chapters: [
        {
          id: target(r).id,
          title: target(r).title,
          content: "改后",
          stage: "complete",
        },
      ],
      notes: [
        { id: noteId, type: "character", title: "人物", body: "新人物设定" },
      ],
    });
  });
  noteId = execute({
    type: "note.save",
    projectId,
    noteType: "character",
    title: "人物",
    body: "旧人物设定",
    sources: [],
  });
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "修改",
    tokenBudget: 30000,
  });
  expect((await done(runner, id)).status).toBe("awaiting-author");
  expect(sawPending).toBe(true);
  expect(store.get("notes", noteId)!.body).toBe("旧人物设定");
  runner.command({ type: "revision.accept", id, includeMaterials: true });
  const n = store.get("notes", noteId)!;
  expect(n.body).toBe("新人物设定");
  expect(
    n.sources.every(
      (s) => s.revision === store.get("chapters", s.id)!.revision,
    ),
  ).toBe(true);
});
it("does not create material proposals or invalidate prose for unchanged model fields", async () => {
  let noteId = "";
  const { runner, projectId, store, execute } = setup(() =>
    JSON.stringify({
      message: "已检查，无需修改",
      chapters: [],
      project: { background: "" },
      notes: [
        { id: noteId, type: "character", title: "人物", body: "相同设定" },
      ],
    }),
  );
  noteId = execute({
    type: "note.save",
    projectId,
    noteType: "character",
    title: "人物",
    body: "相同设定",
    sources: [],
  });
  const before = store.chapterMetadata(projectId).map((c) => c.revision);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "全书检查",
    tokenBudget: 30000,
  });
  const j = await done(runner, id);
  expect(j.status).toBe("completed");
  expect(j.notes).toEqual([]);
  expect(j.projectPatch).toBeUndefined();
  expect(store.chapterMetadata(projectId).map((c) => c.revision)).toEqual(
    before,
  );
});
it("refuses adoption when an unselected adjacent reference was manually changed", async () => {
  const { runner, store, execute, projectId, chapters } = setup(changed);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "chapters",
    chapterIds: chapters.slice(0, 2).map((c) => c.id),
    text: "联动改稿",
    tokenBudget: 30000,
  });
  await done(runner, id);
  const neighbor = store.get("chapters", chapters[2].id)!;
  execute({
    type: "chapter.save",
    id: neighbor.id,
    revision: neighbor.revision,
    content: "第三章关键事实由作者修改",
  });
  expect(() => runner.command({ type: "revision.accept", id })).toThrow(
    /参考|来源|变化|修改/,
  );
  expect(store.get("chapters", chapters[1].id)!.content).toBe(
    chapters[1].content,
  );
});
it("starts from duplicate-quote annotations after metadata invalidation, but rejects changed source prose", async () => {
  const { runner, store, execute, projectId, chapters } = setup(changed);
  const second = chapters[1];
  execute({
    type: "chapter.save",
    id: second.id,
    revision: second.revision,
    content: "前。重复。后。重复。末。",
  });
  const source = store.get("chapters", second.id)!;
  const start = source.content.lastIndexOf("重复"),
    stamp = new Date().toISOString();
  store.put("readingWorkspaces", {
    id: "workspace",
    projectId,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    annotations: [
      {
        id: "annotation",
        chapterId: source.id,
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
        anchor: {
          chapterId: source.id,
          revision: source.revision,
          start,
          end: start + 2,
          quote: "重复",
        },
        text: "修改第二处",
        status: "open",
      },
    ],
    reviews: [],
    volumes: [],
  });
  const first = store.get("chapters", chapters[0].id)!;
  execute({
    type: "chapter.save",
    id: first.id,
    revision: first.revision,
    content: "第一章修改只影响元数据",
  });
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "chapters",
    chapterIds: [source.id],
    annotationIds: ["annotation"],
    text: "修改批注",
    tokenBudget: 30000,
  });
  await done(runner, id);
  const current = store.get("chapters", source.id)!;
  execute({
    type: "chapter.save",
    id: source.id,
    revision: current.revision,
    content: current.content + "新增事实",
  });
  expect(() =>
    runner.start({
      type: "revision.start",
      projectId,
      scope: "chapters",
      chapterIds: [source.id],
      annotationIds: ["annotation"],
      text: "修改批注",
      tokenBudget: 30000,
    }),
  ).toThrow(/来源|修改/);
});
it("requires joint adoption of candidates that read a pending neighbor, and blocks rejected dependencies", async () => {
  const { runner, projectId, chapters, store } = setup(changed);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "chapters",
    chapterIds: chapters.slice(0, 2).map((c) => c.id),
    text: "联动改稿",
    tokenBudget: 30000,
  });
  await done(runner, id);
  expect(() =>
    runner.command({
      type: "revision.accept",
      id,
      chapterIds: [chapters[1].id],
    }),
  ).toThrow(/一起|关联|联动/);
  expect(store.get("chapters", chapters[1].id)!.content).toBe(
    chapters[1].content,
  );
  runner.command({ type: "revision.reject", id, chapterIds: [chapters[0].id] });
  expect(() =>
    runner.command({
      type: "revision.accept",
      id,
      chapterIds: [chapters[1].id],
    }),
  ).toThrow(/拒绝|关联|联动/);
});
it("gives each provider call exactly one explicit allowed chapter despite the broader author instruction", async () => {
  const seen: string[] = [];
  const { runner, projectId, chapters } = setup((r) => {
    const data = JSON.parse(r.messages.at(-1)!.content);
    const current = target(r).id;
    expect(data.allowedChapterIds).toEqual([current]);
    expect(r.messages[0].content).toContain(
      `本轮唯一允许回写的 chapter.id = ${current}`,
    );
    expect(r.messages[0].content).toContain(
      "adjacentContext 仅供参考，不得返回相邻章节",
    );
    seen.push(current);
    return changed(r);
  });
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "chapters",
    chapterIds: chapters.slice(0, 2).map((c) => c.id),
    text: "两章一起改，保持一致",
    tokenBudget: 30000,
  });
  expect((await done(runner, id)).status).toBe("awaiting-author");
  expect(seen).toEqual(chapters.slice(0, 2).map((c) => c.id));
});
it("supports a bounded billion-token total budget for large books", async () => {
  const { MAX_REVISION_TOKEN_BUDGET } = await import("../src/shared/revision");
  expect(MAX_REVISION_TOKEN_BUDGET).toBe(1000000000);
  const { runner, projectId } = setup(changed);
  const id = runner.start({
    type: "revision.start",
    projectId,
    scope: "all",
    text: "逐章改稿",
    tokenBudget: MAX_REVISION_TOKEN_BUDGET,
  });
  expect((await done(runner, id)).checkedChapterIds).toHaveLength(3);
  expect(() =>
    runner.start({
      type: "revision.start",
      projectId,
      scope: "all",
      text: "逐章改稿",
      tokenBudget: MAX_REVISION_TOKEN_BUDGET + 1,
    }),
  ).toThrow(/预算/);
});
