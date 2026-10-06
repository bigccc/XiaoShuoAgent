import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
let store: Store;
let domain: any;
beforeEach(() => {
  store = new Store(":memory:");
  domain = new DomainService(store, {
    encryptKey: (key: string) => Buffer.from(`encrypted:${key}`),
  });
});
afterEach(() => store.close());
const createProject = () => {
  const r = domain.execute({ type: "project.create", title: "山海书" });
  expect(r.ok).toBe(true);
  return r.entityId as string;
};
const createChapter = (projectId: string, ordinal = 1) => {
  const r = domain.execute({
    type: "chapter.create",
    projectId,
    ordinal,
    title: `第${ordinal}章`,
  });
  expect(r.ok).toBe(true);
  return r.entityId as string;
};
describe("author-controlled durable domain", () => {
  it("rejects empty titles and invalid runtime payloads in Chinese", () => {
    for (const payload of [
      { type: "project.create", title: " " },
      { type: "project.create", title: 4 },
      { type: "chapter.save", id: "x", revision: -1, content: "x" },
      null,
    ]) {
      const r = domain.execute(payload as never);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("VALIDATION");
      expect(r.error.message).toMatch(/[\u4e00-\u9fff]/);
    }
    expect(domain.snapshot().projects).toHaveLength(0);
  });
  it("rejects a stale chapter save without changing content or history", () => {
    const p = createProject();
    const id = createChapter(p);
    expect(
      domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "作者文本",
      }).ok,
    ).toBe(true);
    const before = domain.snapshot();
    const r = domain.execute({
      type: "chapter.save",
      id,
      revision: 1,
      content: "覆盖文本",
    });
    expect(r.error.code).toBe("CONFLICT");
    expect(domain.snapshot()).toEqual(before);
  });
  it("fails nonexistent project mutations without orphan objects", () => {
    for (const c of [
      {
        type: "project.update",
        id: "missing",
        revision: 1,
        patch: { title: "新书" },
      },
      {
        type: "chapter.create",
        projectId: "missing",
        ordinal: 1,
        title: "第一章",
      },
      {
        type: "note.save",
        projectId: "missing",
        title: "人物",
        noteType: "character",
        body: "主角",
        sources: [],
      },
    ])
      expect(domain.execute(c as never).error.code).toBe("NOT_FOUND");
    expect(domain.snapshot().chapters).toEqual([]);
    expect(domain.snapshot().notes).toEqual([]);
  });
  it("keeps confirmation explicit and restores without losing either history", () => {
    const p = createProject();
    const id = createChapter(p);
    domain.execute({ type: "chapter.save", id, revision: 1, content: "原文" });
    const original = domain
      .snapshot()
      .versions.find((v: any) => v.content === "原文");
    domain.execute({ type: "chapter.confirm", id, revision: 2 });
    domain.execute({
      type: "chapter.save",
      id,
      revision: 3,
      content: "修改文",
    });
    expect(domain.snapshot().chapters[0].status).toBe("draft");
    const r = domain.execute({
      type: "chapter.restore",
      id,
      revision: 4,
      versionId: original.id,
    });
    expect(r.ok).toBe(true);
    expect(domain.snapshot().chapters[0].content).toBe("原文");
    expect(domain.snapshot().chapters[0].status).toBe("draft");
    expect(domain.snapshot().versions.map((v: any) => v.content)).toEqual(
      expect.arrayContaining(["原文", "修改文"]),
    );
    expect(
      domain
        .snapshot()
        .versions.some(
          (v: any) => v.status === "confirmed" && v.content === "原文",
        ),
    ).toBe(true);
  });
  it("marks later drafts for review after preceding text or settings change without altering confirmed text", () => {
    const p = createProject();
    const first = createChapter(p);
    const second = createChapter(p, 2);
    const third = createChapter(p, 3);
    domain.execute({
      type: "chapter.save",
      id: third,
      revision: 1,
      content: "已确认原文",
    });
    domain.execute({ type: "chapter.confirm", id: third, revision: 2 });
    domain.execute({
      type: "chapter.save",
      id: first,
      revision: 1,
      content: "前文变化",
    });
    expect(
      domain.snapshot().chapters.find((c: any) => c.id === second).needsReview,
    ).toBe(true);
    expect(
      domain.execute({
        type: "project.update",
        id: p,
        revision: 1,
        patch: { style: "轻松" },
      }).ok,
    ).toBe(true);
    const confirmed = domain
      .snapshot()
      .chapters.find((c: any) => c.id === third);
    expect(confirmed.content).toBe("已确认原文");
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.needsReview).toBe(true);
  });
  it("stores AI candidates without replacing author content and rejects stale source revisions", () => {
    const p = createProject();
    const id = createChapter(p);
    domain.execute({
      type: "chapter.save",
      id,
      revision: 1,
      content: "作者文本",
    });
    domain.execute({ type: "chapter.confirm", id, revision: 2 });
    const before = domain.snapshot().chapters[0];
    const sourceRevisions = [{ kind: "chapter", id, revision: 3 }];
    expect(
      domain.saveCandidate({
        chapterId: id,
        content: "AI候选",
        taskId: "task-1",
        sourceRevisions,
      }).ok,
    ).toBe(true);
    expect(domain.snapshot().chapters[0]).toEqual(before);
    expect(
      domain
        .snapshot()
        .versions.some(
          (v: any) => v.content === "AI候选" && v.reason === "ai-candidate",
        ),
    ).toBe(true);
    expect(
      domain.saveCandidate({
        chapterId: id,
        content: "旧结果",
        taskId: "task-2",
        sourceRevisions: [{ kind: "chapter", id, revision: 1 }],
      }).error.code,
    ).toBe("CONFLICT");
  });
  it("masks encrypted credentials in snapshots and preserves key on profile edit", () => {
    const r = domain.execute({
      type: "profile.save",
      name: "个人模型",
      baseUrl: "https://example.com/v1",
      model: "model",
      purpose: "writing",
      apiKey: "secret-xyz",
    });
    expect(r.ok).toBe(true);
    const profile = domain.snapshot().profiles[0];
    expect(profile.hasKey).toBe(true);
    expect(
      domain.execute({
        type: "profile.save",
        id: profile.id,
        revision: 1,
        name: "改名",
        baseUrl: profile.baseUrl,
        model: profile.model,
        purpose: "writing",
      }).ok,
    ).toBe(true);
    expect(domain.snapshot().profiles[0].hasKey).toBe(true);
    expect(JSON.stringify(domain.snapshot())).not.toContain("secret-xyz");
    expect(JSON.stringify(r)).not.toContain("secret-xyz");
  });
  it("supports note, material, linking, archive and revision-checked deletes", () => {
    const p = createProject();
    const n = domain.execute({
      type: "note.save",
      projectId: p,
      noteType: "world",
      title: "规则",
      body: "不可飞行",
      sources: [],
    });
    expect(n.ok).toBe(true);
    expect(
      domain.execute({
        type: "note.save",
        id: n.entityId,
        revision: 1,
        projectId: p,
        noteType: "world",
        title: "规则",
        body: "可以飞行",
        sources: [],
      }).ok,
    ).toBe(true);
    expect(
      domain.execute({ type: "note.delete", id: n.entityId, revision: 1 }).error
        .code,
    ).toBe("CONFLICT");
    expect(
      domain.execute({ type: "note.delete", id: n.entityId, revision: 2 }).ok,
    ).toBe(true);
    const m = domain.execute({
      type: "material.save",
      materialType: "expression",
      title: "对白",
      source: "作者输入",
      content: "走着瞧",
      explanation: "争执场景",
      approved: true,
    });
    expect(m.ok).toBe(true);
    expect(
      domain.execute({
        type: "material.link",
        id: m.entityId,
        revision: 1,
        projectId: p,
      }).ok,
    ).toBe(true);
    expect(
      domain.snapshot().materials[0].projectReferences[0].snapshot.content,
    ).toBe("走着瞧");
    expect(
      domain.execute({ type: "project.archive", id: p, revision: 1 }).ok,
    ).toBe(true);
    expect(domain.snapshot().projects[0].archived).toBe(true);
  });
});

it("does not invalidate an outline immediately after the author saves it", () => {
  const p = createProject();
  const r = domain.execute({
    type: "note.save",
    projectId: p,
    noteType: "outline",
    title: "全书大纲",
    body: "新计划",
    sources: [],
  });
  expect(r.ok).toBe(true);
  expect(domain.snapshot().notes[0].needsReview).toBe(false);
  expect(r.revision).toBe(1);
});
it("rejects an update revision without an object ID rather than creating a duplicate", () => {
  const r = domain.execute({
    type: "profile.save",
    revision: 1,
    name: "模型",
    baseUrl: "https://example.com",
    model: "m",
    purpose: "planning",
  });
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe("VALIDATION");
  expect(domain.snapshot().profiles).toEqual([]);
});
it("restoring an upstream version invalidates later drafts and adopting a candidate never confirms it", () => {
  const p = createProject();
  const first = createChapter(p);
  const second = createChapter(p, 2);
  domain.execute({
    type: "chapter.save",
    id: first,
    revision: 1,
    content: "初稿",
  });
  const v = domain.snapshot().versions.find((v: any) => v.content === "初稿");
  domain.execute({
    type: "chapter.save",
    id: second,
    revision: 2,
    content: "后文",
  });
  domain.execute({ type: "chapter.confirm", id: second, revision: 3 });
  expect(
    domain.execute({
      type: "chapter.restore",
      id: first,
      revision: 2,
      versionId: v.id,
    }).ok,
  ).toBe(true);
  expect(domain.snapshot().chapters[1].needsReview).toBe(true);
  expect(domain.snapshot().chapters[1].content).toBe("后文");
  const candidate = domain.saveCandidate({
    chapterId: first,
    content: "AI重写",
    taskId: "t",
    sourceRevisions: [{ kind: "chapter", id: first, revision: 3 }],
  });
  expect(
    domain.execute({
      type: "chapter.restore",
      id: first,
      revision: 3,
      versionId: candidate.entityId,
    }).ok,
  ).toBe(true);
  expect(domain.snapshot().chapters[0].content).toBe("AI重写");
  expect(domain.snapshot().chapters[0].status).toBe("draft");
});
it("keeps linked material provenance on edits and guards both material/profile deletes", () => {
  const p = createProject();
  const m = domain.execute({
    type: "material.save",
    materialType: "plot",
    title: "反转",
    source: "原出处",
    content: "原桥段",
    explanation: "",
    approved: true,
  });
  domain.execute({
    type: "material.link",
    id: m.entityId,
    revision: 1,
    projectId: p,
  });
  domain.execute({
    type: "material.save",
    id: m.entityId,
    revision: 2,
    materialType: "plot",
    title: "反转",
    source: "新出处",
    content: "新桥段",
    explanation: "",
    approved: true,
  });
  expect(
    domain.snapshot().materials[0].projectReferences[0].snapshot.source,
  ).toBe("原出处");
  expect(
    domain.execute({ type: "material.delete", id: m.entityId, revision: 3 }).ok,
  ).toBe(false);
  domain.execute({
    type: "material.link",
    id: m.entityId,
    revision: 3,
    projectId: p,
    linked: false,
  });
  expect(
    domain.execute({ type: "material.delete", id: m.entityId, revision: 4 }).ok,
  ).toBe(true);
  const profile = domain.execute({
    type: "profile.save",
    name: "模型",
    baseUrl: "https://example.com",
    model: "m",
    purpose: "planning",
    apiKey: "secret",
  });
  expect(
    domain.execute({
      type: "profile.delete",
      id: profile.entityId,
      revision: 2,
    }).error.code,
  ).toBe("CONFLICT");
  expect(
    domain.execute({
      type: "profile.delete",
      id: profile.entityId,
      revision: 1,
    }).ok,
  ).toBe(true);
  expect(store.hasProfileKey(profile.entityId)).toBe(false);
});
it("preserves original material provenance when an already linked project links again", () => {
  const projectId = createProject();
  const saved = domain.execute({
    type: "material.save",
    materialType: "plot",
    title: "反转",
    source: "原出处",
    content: "原桥段",
    explanation: "初次适用条件",
    approved: true,
  });
  const id = saved.entityId;
  expect(
    domain.execute({ type: "material.link", id, revision: 1, projectId }).ok,
  ).toBe(true);
  const originalLinkedAt =
    domain.snapshot().materials[0].projectReferences[0].linkedAt;
  expect(
    domain.execute({
      type: "material.save",
      id,
      revision: 2,
      materialType: "plot",
      title: "新反转",
      source: "新出处",
      content: "新桥段",
      explanation: "新的适用条件",
      approved: true,
    }).ok,
  ).toBe(true);
  const repeated = domain.execute({
    type: "material.link",
    id,
    revision: 3,
    projectId,
    linked: true,
  });
  expect(repeated.ok).toBe(true);
  const refs = domain.snapshot().materials[0].projectReferences;
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatchObject({
    projectId,
    linkedAt: originalLinkedAt,
    snapshot: {
      title: "反转",
      source: "原出处",
      content: "原桥段",
      explanation: "初次适用条件",
      revision: 1,
    },
  });
  const unlinked = domain.execute({
    type: "material.link",
    id,
    revision: repeated.revision,
    projectId,
    linked: false,
  });
  expect(unlinked.ok).toBe(true);
  expect(
    domain.execute({
      type: "material.link",
      id,
      revision: unlinked.revision,
      projectId,
      linked: true,
    }).ok,
  ).toBe(true);
  expect(
    domain.snapshot().materials[0].projectReferences[0].snapshot,
  ).toMatchObject({
    title: "新反转",
    source: "新出处",
    content: "新桥段",
    explanation: "新的适用条件",
  });
});

it("keeps accepted planning ancestors current through character world outline and chapter outline", async () => {
  const { buildContext } = await import("../src/main/context");
  const projectId = createProject();
  for (const [noteType, title] of [
    ["character", "人物原文"],
    ["world", "世界原文"],
    ["outline", "大纲原文"],
    ["chapterOutline", "章纲原文"],
  ] as const) {
    const context = buildContext(domain.snapshot(), projectId);
    const r = domain.execute({
      type: "note.save",
      projectId,
      noteType,
      title,
      body: title,
      sources: context.sources,
    });
    expect(r.ok).toBe(true);
    const state = domain.snapshot();
    expect(state.notes.every((n: any) => !n.needsReview)).toBe(true);
    expect(
      buildContext(state, projectId)
        .documents.filter((d: any) => d.source.kind === "note")
        .map((d: any) => d.label),
    ).toHaveLength(state.notes.length);
  }
});
it("marks only derived downstream notes after an ancestor edit while retaining content and revision conflicts", async () => {
  const { buildContext } = await import("../src/main/context");
  const projectId = createProject();
  const character = domain.execute({
    type: "note.save",
    projectId,
    noteType: "character",
    title: "人物",
    body: "十七岁",
    sources: [],
  });
  const world = domain.execute({
    type: "note.save",
    projectId,
    noteType: "world",
    title: "世界",
    body: "世界原文",
    sources: [
      { kind: "note", id: character.entityId, revision: character.revision },
    ],
  });
  const outline = domain.execute({
    type: "note.save",
    projectId,
    noteType: "outline",
    title: "大纲",
    body: "大纲原文",
    sources: [{ kind: "note", id: world.entityId, revision: world.revision }],
  });
  const unrelated = domain.execute({
    type: "note.save",
    projectId,
    noteType: "location",
    title: "独立地点",
    body: "湖畔",
    sources: [{ kind: "project", id: projectId, revision: 1 }],
  });
  const current = domain
    .snapshot()
    .notes.find((n: any) => n.id === character.entityId);
  expect(
    domain.execute({
      type: "note.save",
      id: character.entityId,
      revision: current.revision,
      projectId,
      noteType: "character",
      title: "人物",
      body: "十八岁",
      sources: [],
    }).ok,
  ).toBe(true);
  const state = domain.snapshot();
  expect(state.notes.find((n: any) => n.id === world.entityId)).toMatchObject({
    body: "世界原文",
    needsReview: true,
  });
  expect(state.notes.find((n: any) => n.id === outline.entityId)).toMatchObject(
    { body: "大纲原文", needsReview: true },
  );
  expect(
    state.notes.find((n: any) => n.id === unrelated.entityId).needsReview,
  ).toBe(false);
  expect(buildContext(state, projectId).text).not.toContain("世界原文");
  expect(
    domain.execute({
      type: "note.save",
      id: character.entityId,
      revision: current.revision,
      projectId,
      noteType: "character",
      title: "人物",
      body: "旧覆盖",
      sources: [],
    }).error.code,
  ).toBe("CONFLICT");
});
it("accepts chapter-derived facts without invalidating their confirmed upstream chapter", async () => {
  const { buildContext } = await import("../src/main/context");
  const projectId = createProject(),
    id = createChapter(projectId);
  domain.execute({
    type: "chapter.save",
    id,
    revision: 1,
    content: "林舟十七岁。",
  });
  domain.execute({ type: "chapter.confirm", id, revision: 2 });
  const before = domain.snapshot().chapters[0];
  for (const noteType of ["summary", "knowledge"] as const) {
    const r = domain.execute({
      type: "note.save",
      projectId,
      noteType,
      title: noteType,
      body: "林舟十七岁。",
      sources: [{ kind: "chapter", id, revision: before.revision }],
    });
    expect(r.ok).toBe(true);
    expect(domain.snapshot().chapters[0]).toEqual(before);
    expect(
      buildContext(domain.snapshot(), projectId).documents.some(
        (d: any) => d.source.id === r.entityId,
      ),
    ).toBe(true);
  }
  expect(
    domain.execute({
      type: "chapter.save",
      id,
      revision: before.revision,
      content: "林舟十八岁。",
    }).ok,
  ).toBe(true);
  expect(domain.snapshot().notes.every((n: any) => n.needsReview)).toBe(true);
  expect(
    domain.snapshot().notes.every((n: any) => n.body === "林舟十七岁。"),
  ).toBe(true);
});
