import { afterEach, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { ProjectFiles } from "../src/main/files";
import { detectWritingGoal, hasUnresolvedWritingGoal, validateWritingJob, type WritingJob } from "../src/shared/writing";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "writing-storage-"));
  directories.push(path);
  return path;
}
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const domain = new DomainService(store);
  const project = domain.execute({ type: "project.create", title: "连续写作" });
  if (!project.ok) throw Error(project.error.message);
  const chapter = domain.execute({ type: "chapter.create", projectId: project.entityId, ordinal: 1, title: "第一章" });
  if (!chapter.ok) throw Error(chapter.error.message);
  return { store, domain, projectId: project.entityId, chapterId: chapter.entityId };
}
function job(projectId: string, chapterId?: string): WritingJob {
  const time = new Date().toISOString();
  return {
    id: "writing", revision: 1, createdAt: time, updatedAt: time, projectId,
    profileId: "local-writing-model", checkingProfileId: "local-checking-model",
    text: "写完前五章", goal: { kind: "through", startOrdinal: 1, endOrdinal: 5 },
    status: "running", phase: "planning", chapters: Array.from({ length: 5 }, (_, i) => ({
      ordinal: i + 1, ...(i === 0 && chapterId ? { chapterId } : {}),
      existing: i === 0 && !!chapterId, status: "pending", revisionRounds: 0,
    })), cursor: 0, plan: "任务规划", planningDone: false, reviewCursor: 0, reviewRounds: 0,
    issues: [], revisionJobIds: [], warnings: [], tokenBudget: 100000,
    budgetUsed: 1800, usage: { inputTokens: 1000, outputTokens: 800, totalTokens: 1800, estimated: false },
    calls: 1, reply: "准备规划",
  };
}
function writePack(path: string, pack: any) {
  pack.sha256 = createHash("sha256").update(JSON.stringify(pack.payload)).digest("hex");
  writeFileSync(path, JSON.stringify(pack));
}

it("includes durable writing jobs in a new database snapshot", () => {
  const store = new Store(":memory:");
  stores.push(store);
  expect((store.snapshot() as any).writingJobs).toEqual([]);
  expect(store.snapshot().schemaVersion).toBe(9);
});

it.each([
  "写完前五章", "帮我把前五章写完", "完成第1到5章", "请把前5章写完",
  "帮我写前五章", "帮我把前五章都写完", "请把前五章写完吧", "一口气写完前五章",
  "请把这本书写到第五章", "帮我把正文写到5章", "写到第五章", "请写前五章正文",
  "按之前讨论的设定，写完前五章", "按之前分析的设定，帮我把前五章都写完",
])("recognizes the full through goal in %s", (text) => {
  expect(detectWritingGoal(text, 2)).toEqual({ kind: "through", startOrdinal: 1, endOrdinal: 5 });
});
it.each(["连续写五章", "接着写5章", "请连续写五章", "一口气写五章", "帮我再写五章吧"])("appends after the last ordinal for %s", (text) => {
  expect(detectWritingGoal(text, 8)).toEqual({ kind: "append", startOrdinal: 9, endOrdinal: 13 });
});

it.each(["帮我创作前五章", "写完前几章", "写完前五章还是前十章", "连续写101章", "完成第2到5章", "写完前五章，接着写五章", "请把前五章写完并直接发布", "按之前讨论的设定，帮我创作前五章"])("requests clarification rather than one chapter for unresolved execution %s", (text) => {
  expect(detectWritingGoal(text, 2)).toBeNull();
  expect(hasUnresolvedWritingGoal(text)).toBe(true);
});
it.each([
  "写完前五章", "不要写完前五章", "先别连续写五章", "讨论一下怎么写完前五章", "如果写完前五章会怎样", "试写前五章", "修改前五章", "检查前五章", "怎么把故事写到第五章", "帮我想想前五章怎么写", "写完",
  "写第一章", "写第十五章", "帮我创作第一章", "先写一章", "先不要执行，帮我把前五章写完",
])("does not request goal clarification for accepted or non-execution input %s", (text) => {
  expect(hasUnresolvedWritingGoal(text)).toBe(false);
});
it.each([
  "不要写完前五章", "先别连续写五章", "讨论一下怎么写完前五章", "如果写完前五章会怎样", "试写前五章", "修改前五章", "帮我写完", "写完前几章",
  "写完前五章还是前十章", "写完前五章，接着写五章", "写完前101章", "连续写101章", "写完前零章", "接着写0章", "完成第2到5章", "先不要执行，帮我把前五章写完",
])( "does not invent an executable goal for %s", (text) => {
  expect(detectWritingGoal(text, 2)).toBeNull();
});
it("accepts bounded Chinese counts and a separate restriction on existing prose", () => {
  expect(detectWritingGoal("写完前二十章", 2)).toEqual({ kind: "through", startOrdinal: 1, endOrdinal: 20 });
  expect(detectWritingGoal("接着写五章", 100)).toEqual({ kind: "append", startOrdinal: 101, endOrdinal: 105 });
  expect(detectWritingGoal("写完前五章，不要修改已有正文", 2)).toEqual({ kind: "through", startOrdinal: 1, endOrdinal: 5 });
});
it("validates progress and rejects corrupt, excessive or misleading completed states", () => {
  const value = job("p");
  expect(() => validateWritingJob(value)).not.toThrow();
  for (const change of [
    { goal: { kind: "through", startOrdinal: 1, endOrdinal: 101 } },
    { cursor: 6 }, { reviewRounds: 201 }, { budgetUsed: -1 }, { tokenBudget: 1e9 + 1 },
    { chapters: [value.chapters[0], value.chapters[0]] },
    { status: "completed", phase: "done" },
    { issues: [{ category: "plot", impact: "maybe", reason: "矛盾", evidence: [] }] },
  ]) expect(() => validateWritingJob({ ...value, ...change })).toThrow();
});

it("tracks review windows independently of chapter count and only completes checked chapters with optional advice", () => {
  const value = job("p");
  value.status = "completed"; value.phase = "done"; value.planningDone = true;
  value.cursor = 5; value.reviewCursor = 12; value.reviewRounds = 6;
  value.chapters = value.chapters.map(chapter => ({ ...chapter, chapterId: `c${chapter.ordinal}`, status: "checked", checkedRevision: 1 }));
  expect(() => validateWritingJob(value)).not.toThrow();
  for (const change of [
    { reviewCursor: 100001 }, { reviewRounds: 201 },
    { issues: [{ category: "plot", impact: "blocking", reason: "事实矛盾", evidence: [] }] },
    { issues: [{ category: "length", impact: "local", reason: "篇幅未完成", evidence: [] }] },
    { chapters: value.chapters.map(chapter => ({ ...chapter, status: "needs-review" })) },
    { chapters: value.chapters.map(chapter => ({ ...chapter, revisionRounds: 3 })) },
  ]) expect(() => validateWritingJob({ ...value, ...change })).toThrow();
});
it("migrates a v4 database after making a readable backup", () => {
  const path = join(directory(), "works.sqlite");
  const initial = new Store(path);
  new DomainService(initial).execute({ type: "project.create", title: "旧书保留" });
  initial.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE IF EXISTS writingJobs; PRAGMA user_version=4;");
  old.close();
  const store = new Store(path);
  stores.push(store);
  expect(store.snapshot().projects[0].title).toBe("旧书保留");
  expect(store.snapshot().writingJobs).toEqual([]);
  const backup = readdirSync(path.slice(0, path.lastIndexOf("/"))).find(name => name.includes("before-v5"));
  expect(backup).toBeTruthy();
  const saved = new DatabaseSync(join(path.slice(0, path.lastIndexOf("/")), backup!), { readOnly: true });
  expect(saved.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
  saved.close();
});
it("projects writing progress without the plan or evidence text and preserves full stored detail", () => {
  const { store, projectId, chapterId } = setup();
  const value = job(projectId, chapterId);
  value.plan = "秘密长计划".repeat(2000);
  value.issues = [{ category: "style", impact: "local", reason: "重复表达", chapterId, evidence: [{ quote: "长原文".repeat(1000), source: { kind: "chapter", id: chapterId, revision: 1 } }] }];
  store.put("writingJobs", value);
  const projected = store.workspaceSnapshot(projectId).state!.writingJobs![0];
  expect(projected).toBeDefined();
  expect(projected.plan).toBe("");
  expect(projected.issues[0]).toMatchObject({ reason: "重复表达", evidence: [] });
  expect(projected.chapters[0].chapterId).toBe(chapterId);
  expect(projected.budgetUsed).toBe(1800);
  expect(store.get("writingJobs", value.id)?.plan).toBe(value.plan);
  expect(store.workspaceSnapshot("other").state!.writingJobs).toEqual([]);
});
it("round-trips jobs with new identities, no model ids and no running state", async () => {
  const { store, projectId, chapterId } = setup();
  const value = job(projectId, chapterId);
  value.lastFailedResponse = { phase: "writing", ordinal: 2, rawResponse: '{"content":"保留但不自动应用的失败原文","unexpected":true}', truncated: false };
  value.issues = [{ category: "timeline", impact: "blocking", reason: "时间矛盾", chapterId, evidence: [{ quote: "作者正文", source: { kind: "chapter", id: chapterId, revision: 1 } }] }];
  store.put("writingJobs", value);
  const path = join(directory(), "writing.novel");
  const files = new ProjectFiles(store);
  await files.backup(projectId, path);
  const pack = JSON.parse(readFileSync(path, "utf8"));
  expect(pack.version).toBe(9);
  expect(pack.payload.writingJobs[0].profileId).toBeUndefined();
  expect(pack.payload.writingJobs[0].checkingProfileId).toBeUndefined();
  const importedId = await files.importBackup(path);
  const imported = store.selectByProject("writingJobs", importedId)[0];
  expect(imported.id).not.toBe(value.id);
  expect(imported.status).toBe("interrupted");
  expect(imported.budgetUsed).toBe(1800);
  expect(imported.lastFailedResponse).toEqual(value.lastFailedResponse);
  expect(store.workspaceSnapshot(importedId).state!.writingJobs![0].lastFailedResponse).not.toHaveProperty("rawResponse");
  expect(imported.chapters[0].chapterId).not.toBe(chapterId);
  expect(imported.issues[0].chapterId).toBe(imported.chapters[0].chapterId);
  expect(imported.issues[0].evidence[0].source.id).toBe(imported.chapters[0].chapterId);
  expect(imported.issues[0].evidence[0].quote).toBe("作者正文");
});

it("keeps a valid review source digest locally but clears it when importing remapped sources", async () => {
  const { store, projectId, chapterId } = setup();
  const digest = createHash("sha256").update("versioned sources").digest("hex");
  const value = { ...job(projectId, chapterId), reviewSourceDigest: digest };
  expect(() => validateWritingJob(value)).not.toThrow();
  expect(() => validateWritingJob({ ...value, reviewSourceDigest: "not-a-digest" })).toThrow();
  store.put("writingJobs", value);
  expect(store.workspaceSnapshot(projectId).state!.writingJobs![0].reviewSourceDigest).toBe(digest);
  const path = join(directory(), "review-digest.novel");
  const files = new ProjectFiles(store);
  await files.backup(projectId, path);
  const pack = JSON.parse(readFileSync(path, "utf8"));
  expect(pack.payload.writingJobs[0].reviewSourceDigest).toBe(digest);
  const importedId = await files.importBackup(path);
  expect(store.selectByProject("writingJobs", importedId)[0].reviewSourceDigest).toBeUndefined();
  expect(store.get("writingJobs", value.id)?.reviewSourceDigest).toBe(digest);
});

it("preserves the last automatically saved chapter revision through backup import", async () => {
  const { store, projectId, chapterId } = setup();
  const value = job(projectId, chapterId);
  value.chapters[0] = { ...value.chapters[0], savedRevision: 1 };
  expect(() => validateWritingJob(value)).not.toThrow();
  for (const savedRevision of [0, -1, 1.5, "1"])
    expect(() => validateWritingJob({ ...value, chapters: [{ ...value.chapters[0], savedRevision }, ...value.chapters.slice(1)] })).toThrow();
  store.put("writingJobs", value);
  expect(store.workspaceSnapshot(projectId).state!.writingJobs![0].chapters[0].savedRevision).toBe(1);
  const files = new ProjectFiles(store), path = join(directory(), "saved-revision.novel");
  await files.backup(projectId, path);
  const importedId = await files.importBackup(path);
  const progress = store.selectByProject("writingJobs", importedId)[0].chapters[0];
  expect(progress.savedRevision).toBe(1);
  expect(progress.chapterId).not.toBe(chapterId);
});

it("persists per-chapter check windows, strips their evidence from polling and restarts checks after import", async () => {
  const { store, projectId, chapterId } = setup();
  const digest = createHash("sha256").update("chapter check sources").digest("hex");
  const value = {
    ...job(projectId, chapterId), checkCursor: 3, checkSourceDigest: digest,
    checkIssues: [{ category: "style" as const, impact: "local" as const, reason: "重复描写", chapterId,
      evidence: [{ quote: "必须保留的完整原文", source: { kind: "chapter" as const, id: chapterId, revision: 1 } }] }],
  };
  expect(() => validateWritingJob(value)).not.toThrow();
  for (const patch of [
    { checkCursor: -1 }, { checkCursor: 100001 }, { checkCursor: 1.5 },
    { checkSourceDigest: "invalid" }, { checkIssues: [{ ...value.checkIssues[0], impact: "unknown" }] },
  ]) expect(() => validateWritingJob({ ...value, ...patch })).toThrow();
  store.put("writingJobs", value);
  const projected = store.workspaceSnapshot(projectId).state!.writingJobs![0];
  expect(projected.checkCursor).toBe(3);
  expect(projected.checkSourceDigest).toBe(digest);
  expect(projected.checkIssues![0]).toMatchObject({ reason: "重复描写", evidence: [] });
  expect(JSON.stringify(projected)).not.toContain("必须保留的完整原文");
  const path = join(directory(), "check-windows.novel"), files = new ProjectFiles(store);
  await files.backup(projectId, path);
  const pack = JSON.parse(readFileSync(path, "utf8"));
  expect(pack.payload.writingJobs[0].checkCursor).toBe(3);
  expect(pack.payload.writingJobs[0].checkIssues[0].evidence[0].quote).toBe("必须保留的完整原文");
  const importedId = await files.importBackup(path);
  const imported = store.selectByProject("writingJobs", importedId)[0];
  expect(imported.checkCursor).toBeUndefined();
  expect(imported.checkSourceDigest).toBeUndefined();
  expect(imported.checkIssues).toBeUndefined();
  expect(store.get("writingJobs", value.id)?.checkCursor).toBe(3);
  pack.payload.writingJobs[0].checkIssues[0].evidence[0].source.id = "foreign-chapter";
  writePack(path, pack);
  await expect(files.importBackup(path)).rejects.toThrow();
});
it("imports v4 packages with no writing jobs", async () => {
  const { store, projectId } = setup();
  const path = join(directory(), "legacy.novel");
  const files = new ProjectFiles(store);
  await files.backup(projectId, path);
  const pack = JSON.parse(readFileSync(path, "utf8"));
  pack.version = 4;
  delete pack.payload.writingJobs;
  writePack(path, pack);
  const imported = await files.importBackup(path);
  expect(store.selectByProject("writingJobs", imported)).toEqual([]);
});
it.each(["chapter", "source", "revision"])("rejects invalid %s ownership in a writing backup before importing anything", async (kind) => {
  const { store, projectId, chapterId } = setup();
  const value = job(projectId, chapterId);
  store.put("writingJobs", value);
  const path = join(directory(), "bad.novel");
  const files = new ProjectFiles(store);
  await files.backup(projectId, path);
  const pack = JSON.parse(readFileSync(path, "utf8"));
  const saved = pack.payload.writingJobs[0];
  if (kind === "chapter") saved.chapters[0].chapterId = "foreign-chapter";
  if (kind === "revision") saved.revisionJobIds = ["foreign-revision"];
  if (kind === "source") saved.issues = [{ category: "plot", impact: "blocking", reason: "矛盾", evidence: [{ quote: "原文", source: { kind: "project", id: "foreign-project", revision: 1 } }] }];
  writePack(path, pack);
  await expect(files.importBackup(path)).rejects.toThrow();
  expect(store.list("projects")).toHaveLength(1);
});

it("remaps linked revision jobs while preserving their pending author review", async () => {
  const { store, projectId, chapterId } = setup();
  const time = new Date().toISOString();
  store.put("revisionJobs", {
    id: "pending-revision", revision: 1, createdAt: time, updatedAt: time, projectId,
    text: "待作者审阅", scope: "chapters", chapterIds: [chapterId], annotationIds: [],
    status: "awaiting-author", tokenBudget: 100000, usage: null, calls: 1, checkedChapterIds: [chapterId],
    candidates: [{ chapterId, sourceRevision: 1, title: "第一章", baseContent: "", content: "候选正文", status: "pending" }],
    notes: [], sourceProjectRevision: 1, warnings: [], reply: "待审", materialsStatus: "pending",
  });
  const value = job(projectId, chapterId);
  value.status = "awaiting-author";
  value.revisionJobIds = ["pending-revision"];
  store.put("writingJobs", value);
  const path = join(directory(), "review.novel");
  const files = new ProjectFiles(store);
  await files.backup(projectId, path);
  const importedId = await files.importBackup(path);
  const imported = store.selectByProject("writingJobs", importedId)[0];
  const revision = store.selectByProject("revisionJobs", importedId)[0];
  expect(imported.revisionJobIds).toEqual([revision.id]);
  expect(revision.id).not.toBe("pending-revision");
  expect(revision.status).toBe("awaiting-author");
  expect(revision.candidates[0].chapterId).toBe(imported.chapters[0].chapterId);
  expect(store.get("chapters", imported.chapters[0].chapterId!)?.content).toBe("");
});

it("round-trips a full recovery snapshot and rejects cross-project evidence references", async () => {
  const { store, domain, projectId, chapterId } = setup();
  store.put("writingJobs", job(projectId, chapterId));
  const second = domain.execute({ type: "project.create", title: "另一本作品" });
  if (!second.ok) throw Error();
  const { profiles, schemaVersion, ...payload } = store.snapshot();
  for (const value of payload.writingJobs ?? []) { delete value.profileId; delete value.checkingProfileId; }
  const path = join(directory(), "recovery.novel");
  const pack = { format: "xiaoshuo-recovery", version: 9, payload: { ...payload, schemaVersion }, sha256: "" };
  writePack(path, pack);
  const files = new ProjectFiles(store);
  const importedId = await files.importBackup(path);
  expect(store.selectByProject("writingJobs", importedId)[0].status).toBe("interrupted");
  pack.payload.writingJobs![0].issues = [{ category: "plot", impact: "blocking", reason: "错误引用另一本书", evidence: [{ quote: "其他作品", source: { kind: "project", id: second.entityId, revision: 1 } }] }];
  writePack(path, pack);
  await expect(files.importBackup(path)).rejects.toThrow(/来源|跨作品/);
  expect(store.list("projects")).toHaveLength(4);
});
