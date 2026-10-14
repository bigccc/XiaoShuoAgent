import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import type { JsonValue, SourceRevision } from "../src/shared/types";
function taskSources(projectId: string): SourceRevision[] {
  return [
    { kind: "project", id: projectId, revision: 1 },
    { kind: "chapter", id: "chapter-1", revision: 1 },
  ];
}
function taskRequest(projectId: string, model = "original"): JsonValue {
  const sources = taskSources(projectId);
  const profile = {
    id: "profile-1",
    name: "本地测试",
    baseUrl: "http://127.0.0.1:9999/v1",
    model,
    purpose: "writing",
  };
  return JSON.parse(
    JSON.stringify({
      command: {
        type: "ai.chapter",
        projectId,
        profileId: profile.id,
        chapterIds: ["chapter-1"],
        tokenBudget: 10000,
      },
      profile,
      checkingProfile: profile,
      context: {
        text: "作品快照",
        sources,
        documents: sources.map((source) => ({
          source,
          text: source.kind === "project" ? "作品设定" : "",
          label: source.kind === "project" ? "作品设定" : "目标章节",
        })),
        disclosures: [],
        materials: [],
      },
    }),
  );
}
const paths: string[] = [];
afterEach(() =>
  paths.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), "novel-store-"));
  paths.push(dir);
  return join(dir, "works.sqlite");
}
it("persists authors work and version history across a real SQLite reopen", () => {
  const path = dbPath();
  const a = new Store(path);
  const domain = new DomainService(a);
  expect(domain.execute({ type: "project.create", title: "持久作品" }).ok).toBe(
    true,
  );
  const projectId = domain.snapshot().projects[0].id;
  const created = domain.execute({
    type: "chapter.create",
    projectId,
    ordinal: 1,
    title: "第一章",
  });
  if (!created.ok) throw new Error("setup");
  domain.execute({
    type: "chapter.save",
    id: created.entityId,
    revision: 1,
    content: "中文正文",
  });
  domain.execute({
    type: "chapter.confirm",
    id: created.entityId,
    revision: 2,
  });
  const state = domain.snapshot();
  expect(state.versions).toHaveLength(3);
  a.close();
  const b = new Store(path);
  expect(b.snapshot()).toEqual(state);
  b.close();
});
it("rolls back a transaction when its work throws", () => {
  const a = new Store(":memory:");
  expect(typeof (a as any).transaction).toBe("function");
  expect(() =>
    (a as any).transaction(() => {
      new DomainService(a).execute({ type: "project.create", title: "应回滚" });
      throw new Error("失败");
    }),
  ).toThrow();
  expect(a.snapshot().projects).toEqual([]);
  a.close();
});
it("upgrades a v1 database with a recoverable backup and an empty conversation table", () => {
  const path = dbPath();
  const seed = new Store(path);
  new DomainService(seed).execute({ type: "project.create", title: "升级前的作品" });
  seed.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE conversations; PRAGMA user_version=1;"); legacy.close();
  const upgraded = new Store(path);
  expect(upgraded.snapshot().conversations).toEqual([]);
  expect(upgraded.snapshot().projects[0].title).toBe("升级前的作品");
  expect(readdirSync(paths.at(-1)!).some(f => f.includes("before-v2"))).toBe(true);
  upgraded.close();
});
it("backs up a version zero database before migrating and refuses unknown future versions", () => {
  const path = dbPath();
  const seed = new DatabaseSync(path);
  seed.exec(
    "CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker VALUES ('保留');",
  );
  seed.close();
  const a = new Store(path);
  a.close();
  const files = readdirSync(paths.at(-1)!);
  expect(files.some((f) => f.includes("before-v1"))).toBe(true);
  const b = new DatabaseSync(path);
  expect(b.prepare("SELECT value FROM legacy_marker").get()?.value).toBe(
    "保留",
  );
  b.exec("PRAGMA user_version = 999");
  b.close();
  expect(() => new Store(path)).toThrow(/版本/);
});
it("persists task progress with optimistic revisions and never serializes credentials", () => {
  const a: any = new Store(dbPath());
  expect(typeof a.saveTask).toBe("function");
  const t = {
    id: "task-1",
    projectId: "project-1",
    kind: "generation",
    status: "running",
    requestSnapshot: taskRequest("project-1"),
    result: { candidates: [], disclosures: [] },
    partial: "半章",
    usage: null,
    calls: 1,
    sourceRevisions: taskSources("project-1"),
    revision: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
  a.saveTask(t);
  expect(a.snapshot().tasks[0].partial).toBe("半章");
  expect(() => a.saveTask({ ...t, partial: "冲突" }, 0)).toThrow(/修改/);
  expect(() =>
    a.saveTask({ ...t, id: "task-2", requestSnapshot: { apiKey: "secret" } }),
  ).toThrow(/密钥/);
  a.close();
});
it("rejects invalid issue evidence and preserves evidence when resolving a stored issue", () => {
  const a = new Store(":memory:");
  const d = new DomainService(a);
  const p = d.execute({ type: "project.create", title: "检查作品" });
  if (!p.ok) throw new Error("setup");
  const issue = {
    id: "issue-1",
    revision: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    projectId: p.entityId,
    type: "world" as const,
    reason: "规则冲突",
    evidence: [
      {
        quote: "角色飞行",
        source: { kind: "project" as const, id: p.entityId, revision: 1 },
      },
    ],
    status: "open" as const,
  };
  expect(() => a.saveIssue({ ...issue, evidence: [] })).toThrow(/依据/);
  a.saveIssue(issue);
  expect(
    d.execute({
      type: "issue.resolve",
      id: issue.id,
      revision: 1,
      status: "ignored",
    }).ok,
  ).toBe(true);
  expect(d.snapshot().issues[0].evidence[0].quote).toBe("角色飞行");
  expect(
    d.execute({
      type: "issue.resolve",
      id: issue.id,
      revision: 1,
      status: "resolved",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  a.close();
});
it("keeps a task request snapshot immutable as progress is persisted", () => {
  const a = new Store(":memory:");
  const t = {
    id: "task-fixed",
    projectId: "p",
    kind: "generation" as const,
    status: "running" as const,
    requestSnapshot: taskRequest("p"),
    result: { candidates: [], disclosures: [] },
    partial: "",
    usage: null,
    calls: 0,
    sourceRevisions: taskSources("p"),
    revision: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
  a.saveTask(t);
  expect(() =>
    a.saveTask({ ...t, requestSnapshot: taskRequest("p", "changed") }, 1),
  ).toThrow(/快照/);
  expect(a.snapshot().tasks[0].requestSnapshot).toEqual(taskRequest("p"));
  a.close();
});
it("backs up the complete v2 database before adding persistent synchronization tables", () => {
  const path = dbPath();
  const seed = new Store(path);
  const domain = new DomainService(seed);
  domain.execute({ type: "project.create", title: "同步升级" });
  seed.setProfileKey("private-profile", Buffer.from("opaque-credential"));
  seed.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE IF EXISTS syncJobs; DROP TABLE IF EXISTS syncBatches; PRAGMA user_version=2;");
  legacy.close();
  const upgraded = new Store(path);
  expect(upgraded.snapshot()).toMatchObject({ schemaVersion: 8, syncJobs: [], syncBatches: [], readingWorkspaces: [], revisionJobs: [], writingJobs: [] });
  const backups = readdirSync(paths.at(-1)!).filter(f => f.includes("before-v3"));
  expect(backups).toHaveLength(1);
  const original = new DatabaseSync(join(paths.at(-1)!, backups[0]));
  expect(original.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(JSON.parse(String(original.prepare("SELECT json FROM projects").get()?.json)).title).toBe("同步升级");
  expect(original.prepare("SELECT ciphertext FROM credentials WHERE profile_id=?").get("private-profile")?.ciphertext).toEqual(new Uint8Array(Buffer.from("opaque-credential")));
  expect(original.prepare("SELECT name FROM sqlite_master WHERE name='syncJobs'").get()).toBeUndefined();
  original.close();
  upgraded.close();
});
it("persists synchronization jobs and batches across SQLite reopen", () => {
  const path = dbPath();
  const store = new Store(path);
  const time = "2026-10-09T00:00:00.000Z";
  const job = { id: "job", projectId: "p", revision: 1, createdAt: time, updatedAt: time, stage: "overview" as const, documentRevision: 1, status: "pending" as const, sourceContent: "草稿", baseProjectRevision: 1, baseNoteRevisions: [], conflicts: [], summary: [], calls: 0, usage: null };
  const snapshot = { fields: { title: "标题", genre: "", background: "", style: "", pace: "" }, notes: [], bindings: [], content: "草稿" };
  store.put("syncJobs", job);
  store.put("syncBatches", { origin: "generation", id: "batch", projectId: "p", revision: 1, createdAt: time, updatedAt: time, jobId: "job", stage: "overview", before: snapshot, after: snapshot });
  store.close();
  const reopened = new Store(path);
  expect(reopened.snapshot().syncJobs).toEqual([job]);
  expect(reopened.snapshot().syncBatches[0].after.content).toBe("草稿");
  reopened.close();
});
