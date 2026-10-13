import { afterEach, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const result = new DomainService(store).execute({
    type: "project.create",
    title: "长篇",
  });
  if (!result.ok) throw Error();
  return { store, projectId: result.entityId };
}
it("projects 5,000 chapters without full prose or histories and does not resend unchanged data", () => {
  const { store, projectId } = setup();
  const text = "山".repeat(3000),
    now = new Date().toISOString();
  store.transaction(() => {
    for (let i = 1; i <= 5000; i++) {
      store.put("chapters", {
        id: `c${i}`,
        projectId,
        ordinal: i,
        title: `第${i}章`,
        content: text,
        status: "draft",
        needsReview: false,
        style: "",
        pace: "",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      store.put("versions", {
        id: `v${i}`,
        chapterId: `c${i}`,
        projectId,
        chapterRevision: 1,
        title: `第${i}章`,
        content: text,
        style: "",
        pace: "",
        status: "draft",
        reason: "create",
        createdAt: now,
        sourceRevisions: [],
      });
    }
  });
  const result = (store as any).workspaceSnapshot(projectId);
  expect(result.state.chapters).toHaveLength(5000);
  expect(
    result.state.chapters.every(
      (c: any) =>
        c.content === "" && c.contentLoaded === false && c.wordCount === 3000,
    ),
  ).toBe(true);
  expect(result.state.versions).toEqual([]);
  expect(JSON.stringify(result).length).toBeLessThan(2_000_000);
  expect((store as any).workspaceSnapshot(projectId, result.revision)).toEqual({
    revision: result.revision,
  });
  expect(store.get("chapters", "c4999")?.content).toBe(text);
}, 30000);
it("returns paged literal matches at exact offsets and keeps searches inside the selected work", () => {
  const { store, projectId } = setup();
  const domain = new DomainService(store);
  const c = domain.execute({
    type: "chapter.create",
    projectId,
    ordinal: 1,
    title: "100%",
  });
  if (!c.ok) throw Error();
  domain.execute({
    type: "chapter.save",
    id: c.entityId,
    revision: 1,
    content: "前文\n100% 的承诺\n100% 的承诺",
  });
  const result = (store as any).searchChapterText(projectId, "100%", 0, 1);
  expect(result).toMatchObject({ total: 2, nextOffset: 1 });
  expect(result.matches[0]).toMatchObject({
    chapterId: c.entityId,
    start: 3,
    end: 7,
    revision: 2,
  });
  expect(
    (store as any).searchChapterText(projectId, "100%", 1, 1).matches[0].start,
  ).toBe(12);
  expect((store as any).searchChapterText("other", "100%").matches).toEqual([]);
});
it("selectively reads chapter history and lightweight polls reflect changes", () => {
  const { store, projectId } = setup();
  const before = (store as any).workspaceSnapshot(projectId);
  new DomainService(store).execute({
    type: "chapter.create",
    projectId,
    ordinal: 1,
    title: "首章",
  });
  const result = (store as any).workspaceSnapshot(projectId, before.revision);
  expect(result.state.chapters).toHaveLength(1);
  expect((store as any).selectByProject("versions", projectId)).toHaveLength(1);
});
it("does not resend the chapter directory when only reading position changes", () => {
  const { store, projectId } = setup();
  new DomainService(store).execute({
    type: "chapter.create",
    projectId,
    ordinal: 1,
    title: "首章",
  });
  const before = (store as any).workspaceSnapshot(projectId);
  store.put("readingWorkspaces", {
    id: "reading",
    projectId,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    annotations: [],
    reviews: [],
    volumes: [],
  });
  const result = (store as any).workspaceSnapshot(projectId, before.revision);
  expect(result.chaptersUnchanged).toBe(true);
  expect(result.state.chapters).toEqual([]);
  expect(result.state.readingWorkspaces).toHaveLength(1);
});
it("detects changes committed by a separate database connection when polling", () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-poll-")),
    path = join(directory, "works.sqlite");
  const store = new Store(path);
  const domain = new DomainService(store);
  const p = domain.execute({ type: "project.create", title: "外部恢复" });
  if (!p.ok) throw Error();
  const before = store.workspaceSnapshot(p.entityId);
  const external = new DatabaseSync(path);
  external
    .prepare(
      "UPDATE projects SET json=json_set(json,'$.title','恢复后的标题') WHERE id=?",
    )
    .run(p.entityId);
  external.close();
  const result = store.workspaceSnapshot(p.entityId, before.revision);
  store.close();
  rmSync(directory, { recursive: true, force: true });
  expect(result.state?.projects[0].title).toBe("恢复后的标题");
});
it("pages candidate prose without returning all proposals or source fingerprints", () => {
  const { store, projectId } = setup();
  const time = new Date().toISOString();
  store.put("revisionJobs", {
    id: "revision",
    projectId,
    revision: 1,
    createdAt: time,
    updatedAt: time,
    text: "多章改稿",
    scope: "chapters",
    chapterIds: Array.from({ length: 100 }, (_, i) => `c${i}`),
    annotationIds: [],
    status: "awaiting-author",
    tokenBudget: 100000,
    usage: null,
    calls: 100,
    checkedChapterIds: [],
    notes: [],
    candidates: Array.from({ length: 100 }, (_, i) => ({
      chapterId: `c${i}`,
      sourceRevision: 1,
      title: "章节",
      baseContent: "旧".repeat(3000),
      content: "新".repeat(3000),
      status: "pending",
    })),
    sourceProjectRevision: 1,
    chapterSources: [
      { chapterId: "c0", revision: 1, digest: "secret internal fingerprint" },
    ],
    warnings: [],
    reply: "待审稿",
    materialsStatus: "pending",
  });
  const page = (store as any).revisionDetails("revision", 40, 20);
  expect(page.candidateCount).toBe(100);
  expect(page.candidatePendingCount).toBe(100);
  expect(page.candidates).toHaveLength(20);
  expect(page.candidates[0].chapterId).toBe("c40");
  expect(page.chapterSources).toBeUndefined();
  expect(JSON.stringify(page).length).toBeLessThan(150000);
});
