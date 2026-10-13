import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { ProjectFiles } from "../src/main/files";
import { AppServices } from "../src/main/services";
import type { StageSyncJob, StageSyncBatch, Note, CommandResult } from "../src/shared/types";
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const time = "2026-10-09T00:00:00.000Z";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sync-files-")); dirs.push(dir);
  const store = new Store(join(dir, "db.sqlite")); stores.push(store);
  const domain = new DomainService(store), result = domain.execute({ type: "project.create", title: "同步作品" });
  if (!result.ok) throw Error("fixture");
  const project = store.get("projects", result.entityId)!;
  const note: Note = { id: "note", revision: 2, projectId: project.id, type: "supplement", supplementStage: "settings", title: "补充", body: "保留的原文", sources: [{ kind: "project", id: project.id, revision: 1 }], needsReview: false, archived: false, syncManaged: true, createdAt: time, updatedAt: time };
  const { supplementStage, ...baseHistoric } = note;
  const historic: Note = { ...baseHistoric, id: "historic", title: "旧人物", type: "character", archived: true };
  const binding = { id: "block", kind: "note" as const, noteId: note.id };
  const oldBinding = { id: "old-block", kind: "note" as const, noteId: historic.id };
  const fields = { title: project.title, genre: "", background: "", style: "", pace: "" };
  const job: StageSyncJob = { id: "job", projectId: project.id, revision: 1, createdAt: time, updatedAt: time, stage: "settings", documentRevision: 2, status: "running", sourceContent: "保留的原文", baseProjectRevision: 1, baseNoteRevisions: [{ id: note.id, revision: 2 }], proposal: { stage: "settings", blocks: [{ id: binding.id, kind: "note", noteId: note.id, noteType: "supplement", title: "补充", text: "保留的原文" }], removeNoteIds: [historic.id] }, conflicts: [{ blockId: "block", title: "补充", reason: "修订冲突", noteIds: [note.id, historic.id] }], summary: ["归类补充"], calls: 1, usage: null, profileId: "DO-NOT-EXPORT-PROFILE" };
  const batch: StageSyncBatch = { origin: "generation", id: "batch", projectId: project.id, revision: 1, createdAt: time, updatedAt: time, jobId: job.id, stage: "settings", before: { fields, notes: [historic], bindings: [oldBinding], content: "旧人物原文" }, after: { fields, notes: [note], bindings: [binding], content: "保留的原文" } };
  store.put("notes", note); store.put("notes", historic);
  store.put("syncJobs", job); store.put("syncBatches", batch);
  store.put("projects", { ...project, authoring: { activeStage: "settings", documents: { settings: { content: "保留的原文", revision: 2, approved: false, needsReview: false, history: [{ revision: 1, content: "旧人物原文", createdAt: time, batchId: batch.id }], sync: { status: "running", bindings: [binding], lastSyncedContent: "保留的原文", lastSyncedRevision: 1, jobId: job.id, batchId: batch.id } } } } });
  return { dir, store, files: new ProjectFiles(store), id: project.id, path: join(dir, "package.novel") };
}
function writePack(path: string, payload: any, version = 3, format = "xiaoshuo-project") { writeFileSync(path, JSON.stringify({ format, version, payload, sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") })); }
function payload(f: ReturnType<typeof fixture>) { const { profiles, schemaVersion, ...s } = f.store.snapshot(); return s; }
it("exports v3 sync data without private profiles and remaps every active and historical identity on import", async () => {
  const f = fixture(); await f.files.backup(f.id, f.path);
  const pack = JSON.parse(readFileSync(f.path, "utf8"));
  expect(pack.version).toBe(6); expect(pack.payload.syncJobs).toHaveLength(1); expect(pack.payload.syncBatches).toHaveLength(1);
  expect(readFileSync(f.path, "utf8")).not.toContain("DO-NOT-EXPORT-PROFILE");
  const copy = await f.files.importBackup(f.path), s = f.store.snapshot();
  const note = s.notes.find(n => n.projectId === copy && !n.archived)!, historical = s.notes.find(n => n.projectId === copy && n.archived)!;
  const job = s.syncJobs.find(j => j.projectId === copy)!, batch = s.syncBatches.find(b => b.projectId === copy)!;
  const doc = s.projects.find(p => p.id === copy)!.authoring!.documents.settings!;
  expect(note.id).not.toBe("note"); expect(note.sources[0].id).toBe(copy);
  expect(job.status).toBe("interrupted"); expect(job.profileId).toBeUndefined();
  expect(job.baseNoteRevisions[0].id).toBe(note.id); expect(job.proposal!.blocks[0].noteId).toBe(note.id); expect(job.proposal!.removeNoteIds).toEqual([historical.id]);
  expect(job.conflicts[0].blockId).toBe(doc.sync!.bindings[0].id); expect(job.conflicts[0].noteIds).toEqual([note.id, historical.id]);
  expect(doc.sync!.bindings[0].id).not.toBe("block"); expect(job.proposal!.blocks[0].id).toBe(doc.sync!.bindings[0].id);
  expect(doc.sync).toMatchObject({ status: "pending", jobId: job.id, batchId: batch.id }); expect(doc.history[0].batchId).toBe(batch.id);
  expect(batch.jobId).toBe(job.id); expect(batch.after.bindings).toEqual(doc.sync!.bindings); expect(batch.after.notes[0].id).toBe(note.id); expect(batch.after.notes[0].projectId).toBe(copy); expect(batch.after.notes[0].sources[0].id).toBe(copy);
  expect(batch.before.notes[0].id).toBe(historical.id); expect(batch.before.bindings[0].noteId).toBe(historical.id); expect(batch.before.bindings[0].id).not.toBe("old-block");
});
it.each([1, 2])("verifies original v%i digests before stripping legacy sync metadata and adding empty sync collections", async version => {
  const f = fixture(), s: any = payload(f); delete s.syncJobs; delete s.syncBatches; delete s.conversations;
  if (version === 2) s.conversations = [];
  s.notes = s.notes.filter((n: Note) => n.type === "character");
  writePack(f.path, s, version);
  const copy = await f.files.importBackup(f.path);
  const imported = f.store.snapshot().projects.find(p => p.id === copy)!;
  expect(imported.authoring!.documents.settings!.sync).toBeUndefined();
  expect(imported.authoring!.documents.settings!.history[0].batchId).toBeUndefined();
  expect(f.store.snapshot().notes.find(n => n.projectId === copy)!.archived).toBeUndefined();
  expect(f.store.snapshot().notes.find(n => n.projectId === copy)!.syncManaged).toBeUndefined();
  expect(f.store.snapshot().syncJobs.filter(j => j.projectId === copy)).toEqual([]); expect(f.store.snapshot().syncBatches.filter(j => j.projectId === copy)).toEqual([]);
  writePack(f.path, s, version); const pack = JSON.parse(readFileSync(f.path, "utf8")); pack.payload.projects[0].title = "篡改"; writeFileSync(f.path, JSON.stringify(pack));
  await expect(f.files.importBackup(f.path)).rejects.toThrow(/校验/);
});
it("accepts v3 recovery data and historical notes missing from live records without restoring credentials", async () => {
  const f = fixture(), s: any = payload(f); s.schemaVersion = 3; s.syncJobs[0].status = "pending";
  s.notes = s.notes.filter((n: Note) => !n.archived);
  writePack(f.path, s, 3, "xiaoshuo-recovery");
  const copy = await f.files.importBackup(f.path), result = f.store.snapshot();
  expect(result.syncJobs.find(j => j.projectId === copy)!.status).toBe("interrupted");
  expect(result.syncBatches.find(b => b.projectId === copy)!.before.notes[0].projectId).toBe(copy);
  expect(result.notes.filter(n => n.projectId === copy)).toHaveLength(1);
});
it.each([
  ["active missing note", (s: any) => { s.projects[0].authoring.documents.settings.sync.bindings[0].noteId = "missing"; }],
  ["active archived note", (s: any) => { s.projects[0].authoring.documents.settings.sync.bindings[0].noteId = "historic"; }],
  ["unknown batch", (s: any) => { s.projects[0].authoring.documents.settings.history[0].batchId = "missing"; }],
  ["wrong snapshot project", (s: any) => { s.syncBatches[0].before.notes[0].projectId = "foreign"; }],
  ["invalid archive flag", (s: any) => { s.notes[0].archived = "yes"; }],
  ["invalid supplement stage", (s: any) => { s.notes[0].supplementStage = "writing"; }],
  ["invalid batch origin", (s: any) => { s.syncBatches[0].origin = "unknown"; }],
  ["invalid job block", (s: any) => { s.syncJobs[0].proposal.blocks[0].kind = "arbitrary"; }],
])("rejects v3 %s before mutating the store", async (_name, mutate) => {
  const f = fixture(), s: any = payload(f); mutate(s); writePack(f.path, s);
  await expect(f.files.importBackup(f.path)).rejects.toThrow(); expect(f.store.snapshot().projects).toHaveLength(1);
});
it("rejects recovery sync references to another project's extant note before importing either work", async () => {
  const f = fixture();
  const other = new DomainService(f.store).execute({ type: "project.create", title: "另一部作品" });
  if (!other.ok) throw Error("fixture");
  const original = f.store.get("notes", "note")!;
  f.store.put("notes", { ...original, id: "foreign-note", projectId: other.entityId });
  const s: any = payload(f); s.schemaVersion = 3;
  delete s.projects[0].authoring;
  s.syncJobs[0].baseNoteRevisions[0].id = "foreign-note";
  writePack(f.path, s, 3, "xiaoshuo-recovery");
  await expect(f.files.importBackup(f.path)).rejects.toThrow(/引用/);
  expect(f.store.snapshot().projects).toHaveLength(2);
});
it("retains source-line proposals, long historical note bodies and interrupted drafts across v3 import", async () => {
  const f = fixture(), s: any = payload(f);
  const block = s.syncJobs[0].proposal.blocks[0]; delete block.text; block.startLine = 1; block.endLine = 1;
  s.syncBatches[0].before.notes[0].body = "中文历史原文".repeat(10000);
  s.projects[0].authoring.documents.settings.sync.status = "pending";
  s.syncJobs[0].proposal.removeFields = ["style"];
  writePack(f.path, s);
  const copy = await f.files.importBackup(f.path), state = f.store.snapshot();
  expect(state.syncJobs.find(j => j.projectId === copy)!.proposal!.blocks[0]).toMatchObject({ startLine: 1, endLine: 1 });
  expect(state.syncJobs.find(j => j.projectId === copy)!.proposal!.removeFields).toEqual(["style"]);
  expect(state.syncBatches.find(b => b.projectId === copy)!.before.notes[0].body).toHaveLength(60000);
  expect(state.projects.find(p => p.id === copy)!.authoring!.documents.settings!.sync!.status).toBe("pending");
});
it.each(["xiaoshuo-project", "xiaoshuo-recovery"])("reprojects synced overview on %s import rename while preserving pending drafts and historical batches", async format => {
  const f = fixture(), s: any = payload(f);
  s.projects[0].background = "已有背景";
  const originalContent = "## 作品名称\n同步作品\n\n已有背景";
  const overviewBindings = [{ id: "title-block", kind: "field", field: "title", heading: true }, { id: "background-block", kind: "field", field: "background", heading: false }];
  const overviewJob = { ...s.syncJobs[0], id: "overview-job", stage: "overview", documentRevision: 4, status: "succeeded", sourceContent: originalContent, baseNoteRevisions: [], calls: 0, conflicts: [], proposal: { stage: "overview", blocks: [{ id: "title-block", kind: "field", field: "title", text: "同步作品" }, { id: "background-block", kind: "field", field: "background", text: "已有背景", heading: false }] } };
  const originalSnapshot = { fields: { title: "同步作品", background: "已有背景", genre: "", style: "", pace: "" }, notes: [], bindings: overviewBindings, content: originalContent };
  const overviewBatch = { ...s.syncBatches[0], id: "overview-batch", stage: "overview", jobId: "overview-job", before: originalSnapshot, after: originalSnapshot };
  s.syncJobs.push(overviewJob); s.syncBatches.push(overviewBatch);
  s.projects[0].authoring.documents.overview = { content: originalContent, revision: 4, approved: true, needsReview: false, history: [], sync: { status: "synced", bindings: overviewBindings, lastSyncedContent: originalContent, lastSyncedRevision: 4, jobId: "overview-job", batchId: "overview-batch" } };
  if (format === "xiaoshuo-recovery") s.schemaVersion = 3;
  writePack(f.path, s, 3, format);
  const copy = await f.files.importBackup(f.path), state = f.store.snapshot(), project = state.projects.find(p => p.id === copy)!;
  const doc = project.authoring!.documents.overview!, draft = project.authoring!.documents.settings!;
  expect(project.title).toBe("同步作品（副本）");
  expect(doc.content).toBe("## 作品名称\n同步作品（副本）\n\n已有背景");
  expect(project.revision).toBe(2);
  expect(doc).toMatchObject({ revision: 5, approved: false, needsReview: false });
  expect(doc.sync).toMatchObject({ status: "synced", lastSyncedContent: doc.content, lastSyncedRevision: 5 });
  expect(doc.history).toHaveLength(1); expect(doc.history[0]).toMatchObject({ revision: 4, content: originalContent });
  const historicalBatch = state.syncBatches.find(b => b.id === doc.history[0].batchId)!;
  expect(historicalBatch.after.content).toBe(originalContent); expect(historicalBatch.after.fields.title).toBe("同步作品");
  const currentBatch = state.syncBatches.find(b => b.id === doc.sync!.batchId)!;
  expect(currentBatch.id).not.toBe(historicalBatch.id);
  expect(currentBatch).toMatchObject({ origin: "auxiliary", before: { content: originalContent, fields: { title: "同步作品" } }, after: { content: doc.content, fields: { title: project.title } } });
  expect(currentBatch.after.bindings).toEqual(doc.sync!.bindings);
  const currentJob = state.syncJobs.find(j => j.id === doc.sync!.jobId)!;
  expect(currentBatch.jobId).toBe(currentJob.id); expect(currentJob).toMatchObject({ status: "succeeded", calls: 0, documentRevision: 5, sourceContent: doc.content });
  expect(state.syncJobs.find(j => j.id === historicalBatch.jobId)!.sourceContent).toBe(originalContent);
  expect(draft.content).toBe("保留的原文"); expect(draft.revision).toBe(2); expect(draft.sync).toMatchObject({ status: "pending", lastSyncedContent: "保留的原文", lastSyncedRevision: 1 });
  await f.files.backup(copy, f.path);
  await expect(f.files.importBackup(f.path)).resolves.toBeTypeOf("string");
});
it.each(["xiaoshuo-project", "xiaoshuo-recovery"])("roundtrips one supplement shared by settings and outline in %s without duplicating its identity", async format => {
  const f = fixture();
  const note = f.store.get("notes", "note")!, original = f.store.get("projects", f.id)!;
  const binding = { id: "outline-shared-block", kind: "note" as const, noteId: note.id, heading: true };
  const content = "## 补充\n保留的原文";
  const job: StageSyncJob = { ...f.store.get("syncJobs", "job")!, id: "outline-shared-job", stage: "outline", status: "succeeded", sourceContent: content, documentRevision: 1, conflicts: [], proposal: { stage: "outline", blocks: [{ id: binding.id, kind: "note", noteId: note.id, noteType: "supplement", title: note.title, text: note.body, heading: true }] } };
  const snapshot = { fields: { title: original.title, genre: "", background: "", style: "", pace: "" }, notes: [note], bindings: [binding], content };
  const batch: StageSyncBatch = { ...f.store.get("syncBatches", "batch")!, id: "outline-shared-batch", stage: "outline", jobId: job.id, before: snapshot, after: snapshot };
  f.store.put("syncJobs", job); f.store.put("syncBatches", batch);
  f.store.put("projects", { ...original, authoring: { ...original.authoring!, documents: { ...original.authoring!.documents, outline: { content, revision: 1, approved: false, needsReview: false, history: [], sync: { status: "synced", bindings: [binding], lastSyncedContent: content, lastSyncedRevision: 1, jobId: job.id, batchId: batch.id } } } } });
  if (format === "xiaoshuo-project") await f.files.backup(f.id, f.path);
  else writePack(f.path, { ...payload(f), schemaVersion: 3 }, 3, format);
  const copy = await f.files.importBackup(f.path), state = f.store.snapshot();
  const copiedNote = state.notes.find(n => n.projectId === copy && n.type === "supplement")!;
  expect(state.notes.filter(n => n.projectId === copy && n.type === "supplement")).toHaveLength(1);
  expect(copiedNote.supplementStage).toBe("settings"); expect(copiedNote.id).not.toBe(note.id);
  const docs = state.projects.find(p => p.id === copy)!.authoring!.documents;
  expect(docs.settings!.sync!.bindings[0].noteId).toBe(copiedNote.id);
  expect(docs.outline!.sync!.bindings[0].noteId).toBe(copiedNote.id);
  expect(docs.outline!.sync!.status).toBe("synced"); expect(docs.outline!.content).toBe(content);
  for (const stage of ["settings", "outline"] as const) {
    const copiedJob = state.syncJobs.find(j => j.projectId === copy && j.stage === stage)!;
    const copiedBatch = state.syncBatches.find(b => b.projectId === copy && b.stage === stage)!;
    expect(copiedJob.proposal!.blocks[0].noteId).toBe(copiedNote.id);
    expect(copiedBatch.after.bindings[0].noteId).toBe(copiedNote.id);
    expect(copiedBatch.after.notes[0].id).toBe(copiedNote.id);
    expect(copiedBatch.after.notes[0].supplementStage).toBe("settings");
  }
  await f.files.backup(copy, f.path);
  await expect(f.files.importBackup(f.path)).resolves.toBeTypeOf("string");
});
it("roundtrips absent deleted independent note identities retained only by historical job revisions", async () => {
  const f = fixture(), job = f.store.get("syncJobs", "job")!;
  f.store.put("syncJobs", { ...job, status: "succeeded", baseNoteRevisions: [...job.baseNoteRevisions, { id: "deleted-independent-note", revision: 7 }] });
  await f.files.backup(f.id, f.path);
  const copy = await f.files.importBackup(f.path), state = f.store.snapshot();
  const history = state.syncJobs.find(j => j.projectId === copy)!.baseNoteRevisions.find(n => n.revision === 7)!;
  expect(history.id).not.toBe("deleted-independent-note");
  expect(state.notes.some(n => n.id === history.id)).toBe(false);
  expect(state.syncBatches.filter(b => b.projectId === copy).flatMap(b => [...b.before.notes, ...b.after.notes]).some(n => n.id === history.id)).toBe(false);
});
it.each(["xiaoshuo-project", "xiaoshuo-recovery"])("preserves historical character proposals after an auxiliary category move to storyline in %s", async format => {
  const dir = mkdtempSync(join(tmpdir(), "sync-category-files-")); dirs.push(dir);
  let existingNoteId = "", calls = 0;
  const app = new AppServices({ dataDir: dir, dialogs: { open: async () => null, save: async () => null }, fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: "生成", artifacts: [{ stage: "settings", blocks: [{ kind: "note", noteType: "character", noteId: existingNoteId, title: "人物", text: "原设定" }] }] }) } }] }), { headers: { "Content-Type": "application/json" } });
  } });
  const entityId = (result: CommandResult) => { if (!result.ok) throw Error(result.error.message); return result.entityId!; };
  try {
    const projectId = entityId(app.domain.execute({ type: "project.create", title: "类型调整作品" }));
    entityId(app.domain.execute({ type: "profile.save", name: "测试模型", baseUrl: "http://127.0.0.1:1234/v1", model: "fixture", purpose: "writing" }));
    existingNoteId = entityId(app.domain.execute({ type: "note.save", projectId, noteType: "character", title: "人物", body: "原设定", sources: [] }));
    const turnId = entityId(await app.dispatch({ type: "conversation.send", projectId, text: "生成设定" }));
    await expect.poll(() => app.snapshot().conversations.find(t => t.id === turnId)?.status).toBe("completed");
    const generatedNote = app.snapshot().notes.find(n => n.id === existingNoteId)!;
    entityId(await app.dispatch({ type: "note.save", projectId, id: generatedNote.id, revision: generatedNote.revision, noteType: "storyline", title: generatedNote.title, body: generatedNote.body, sources: [] }));
    expect(app.snapshot().notes.find(n => n.id === existingNoteId)!.type).toBe("storyline"); expect(calls).toBe(1);
    await app.dispose();
    const store = new Store(join(dir, "works.sqlite")); stores.push(store);
    const files = new ProjectFiles(store), path = join(dir, "category-move.novel");
    await files.backup(projectId, path);
    if (format === "xiaoshuo-recovery") {
      const pack = JSON.parse(readFileSync(path, "utf8"));
      writePack(path, { ...pack.payload, schemaVersion: 3 }, 3, format);
    }
    const copy = await files.importBackup(path), state = store.snapshot();
    const copiedNote = state.notes.find(n => n.projectId === copy && n.type === "storyline")!;
    expect(copiedNote.id).not.toBe(existingNoteId);
    const originalProposal = state.syncJobs.find(j => j.projectId === copy && j.stage === "settings" && j.proposal?.blocks.some(b => b.noteType === "character"))!;
    expect(originalProposal.status).toBe("succeeded");
    expect(originalProposal.proposal!.blocks[0]).toMatchObject({ noteId: copiedNote.id, noteType: "character", text: "原设定" });
    const historicalBatch = state.syncBatches.find(b => b.projectId === copy && b.jobId === originalProposal.id)!;
    expect(historicalBatch.after.notes[0]).toMatchObject({ id: copiedNote.id, type: "character", body: "原设定" });
    const docs = state.projects.find(p => p.id === copy)!.authoring!.documents;
    expect(docs.settings!.sync!.bindings.some(b => b.noteId === copiedNote.id)).toBe(false);
    expect(docs.outline!.sync!.bindings.some(b => b.noteId === copiedNote.id)).toBe(true);
    await files.backup(copy, path);
    await expect(files.importBackup(path)).resolves.toBeTypeOf("string");
  } finally { await app.dispose(); }
});
