import {validateScenePlan,validateSceneJob} from "../shared/scenes";
import { validateStoryRecord, validateStoryJob } from "../shared/story-state";
import { chapterDigest,storyContext,storyStampCurrent } from "./story-context";
import { randomUUID, createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
  mkdir,
} from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { AppState, SourceRevision, StageBinding, StageBundle, Note, StageSyncSnapshot, AuthoringState, Project, StageSyncJob, StageSyncBatch } from "../shared/types";
import {
  DomainError,
  validatePublicJson,
  validateSources,
  validateTask,
  validateIssue,
} from "../shared/validation";
import { Store, type Collection } from "./store";
import { validateConversationTurn } from "../shared/conversation";
import { validateAuthoring, planningStages } from "../shared/authoring";
import { validateBundle, renderStage } from "../shared/sync";
import { writeDocument } from "./authoring";
import { validateRevisionJob } from "../shared/revision";
import { authoringDigest } from "./revision";
import { validateWritingJob } from "../shared/writing";
import { validateRecallReferences } from "../shared/recall";
const MAX_SOURCE = 2_000_000,
  MAX_PACKAGE = 512_000_000;
function fail(message: string): never {
  throw new DomainError("VALIDATION", message);
}
export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  if (!isAbsolute(path)) fail("文件路径必须是绝对路径");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
async function boundedRead(path: string, max: number): Promise<Buffer> {
  if ((await stat(path)).size > max) fail("文件大小超过导入限制");
  const bytes = await readFile(path);
  if (bytes.length > max) fail("文件大小超过导入限制");
  return bytes;
}
export async function readMaterialFile(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (![".txt", ".docx"].includes(ext))
    fail("仅支持 TXT 和 DOCX，请将旧 .doc 转换为 .docx");
  const bytes = await boundedRead(
    path,
    ext === ".txt" ? MAX_SOURCE : 10_000_000,
  );
  let text = "";
  if (ext === ".txt") {
    try {
      text = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/, "");
    } catch {
      fail("TXT 编码不受支持，请另存为 UTF-8");
    }
  } else {
    try {
      let total = 0;
      let entries = 0;
      const files = unzipSync(bytes, {
        filter: (info) => {
          total += info.originalSize;
          entries++;
          if (total > 20_000_000 || entries > 1000)
            fail("DOCX 解压大小超过限制");
          return info.name === "word/document.xml";
        },
      });
      if (!files["word/document.xml"]) fail("DOCX 缺少正文文档");
      const xml = strFromU8(files["word/document.xml"]);
      if (
        /<!DOCTYPE|<!ENTITY/i.test(xml) ||
        XMLValidator.validate(xml) !== true
      )
        fail("DOCX 正文 XML 格式不正确");
      const nodes = new XMLParser({
        preserveOrder: true,
        ignoreAttributes: true,
        trimValues: false,
        parseTagValue: false,
      }).parse(xml);
      const walk = (items: any[]): string =>
        items
          .map((item) =>
            Object.entries(item)
              .map(([name, value]) =>
                name === "#text"
                  ? String(value)
                  : name === "w:tab"
                    ? "\t"
                    : name === "w:br" || name === "w:cr"
                      ? "\n"
                      : Array.isArray(value)
                        ? walk(value) + (name === "w:p" ? "\n" : "")
                        : "",
              )
              .join(""),
          )
          .join("");
      text = walk(nodes).replace(/\n$/, "");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      fail("DOCX 无法读取，请检查文件是否损坏或加密");
    }
  }
  if (!text.trim()) fail("文件没有可提取的正文");
  if (text.length > MAX_SOURCE) fail("材料正文长度超过限制");
  return text;
}
const escape = (text: string) =>
  text
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    )
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
const tables = [
  "projects",
  "notes",
  "chapters",
  "versions",
  "materials",
  "tasks",
  "issues",
  "conversations",
  "syncJobs",
  "syncBatches",
  "readingWorkspaces",
  "revisionJobs",
  "writingJobs", "storyRecords", "storyJobs", "scenePlans", "sceneJobs",
] as const;
type Portable = Required<Pick<AppState, (typeof tables)[number]>>;
export class ProjectFiles {
  constructor(private store: Store) {}
  private manuscript(id: string, drafts: boolean): string[] {
    const state = this.store.snapshot(),
      project = state.projects.find((p) => p.id === id);
    if (!project) throw new DomainError("NOT_FOUND", "作品不存在");
    return [
      project.title,
      ...state.chapters
        .filter(
          (c) => c.projectId === id && (drafts || c.status === "confirmed"),
        )
        .sort((a, b) => a.ordinal - b.ordinal)
        .flatMap((c) => [
          c.title,
          ...c.content.replace(/\r\n?/g, "\n").split("\n"),
        ]),
    ];
  }
  async exportText(id: string, path: string, drafts = false): Promise<void> {
    await atomicWrite(path, this.manuscript(id, drafts).join("\n") + "\n");
  }
  async exportDocx(id: string, path: string, drafts = false): Promise<void> {
    const paragraphs = this.manuscript(id, drafts)
      .map(
        (text) =>
          `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`,
      )
      .join("");
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
    await atomicWrite(
      path,
      zipSync({
        "[Content_Types].xml": strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        "_rels/.rels": strToU8(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
        "word/document.xml": strToU8(xml),
      }),
    );
  }
  async backup(id: string, path: string): Promise<void> {
    // Snapshot all tables synchronously before asynchronous I/O. Never enumerate credentials.
    const s = this.store.snapshot(),
      p = s.projects.find((p) => p.id === id);
    if (!p) throw new DomainError("NOT_FOUND", "作品不存在");
    const payload: Portable = {
      projects: [p],
      notes: s.notes.filter((n) => n.projectId === id),
      chapters: s.chapters.filter((c) => c.projectId === id),
      versions: s.versions.filter((v) => v.projectId === id),
      tasks: s.tasks.filter((t) => t.projectId === id),
      issues: s.issues.filter((i) => i.projectId === id),
      syncJobs: s.syncJobs.filter(j => j.projectId === id).map(({ profileId, ...job }) => job),
      syncBatches: s.syncBatches.filter(b => b.projectId === id),
      conversations: s.conversations.filter(t => t.projectId === id).map(({ profileId, ...turn }) => turn),
      readingWorkspaces: (s.readingWorkspaces ?? []).filter(w => w.projectId === id),
      revisionJobs: (s.revisionJobs ?? []).filter(j => j.projectId === id).map(({ profileId, ...job }) => job),
      writingJobs: (s.writingJobs ?? []).filter(j => j.projectId === id).map(({ profileId, checkingProfileId, ...job }) => job),
      scenePlans:(s.scenePlans??[]).filter(p=>p.projectId===id),
      sceneJobs:(s.sceneJobs??[]).filter(j=>j.projectId===id).map(({profileId,...j})=>j),
      storyRecords: (s.storyRecords ?? []).filter(r=>r.projectId===id),
      storyJobs: (s.storyJobs ?? []).filter(j=>j.projectId===id).map(({profileId,...j})=>j),
      materials: s.materials
        .filter((m) => m.projectReferences.some((r) => r.projectId === id))
        .map((m) => {
          const ref = m.projectReferences.find((r) => r.projectId === id)!;
          return {
            ...m,
            ...ref.snapshot,
            revision: m.revision,
            projectReferences: [ref],
          };
        }),
    };
    validatePublicJson(payload);
    await atomicWrite(
      path,
      JSON.stringify({
        format: "xiaoshuo-project",
        version: 7,
        sha256: digest(payload),
        payload,
      }),
    );
  }
  async importBackup(path: string): Promise<string> {
    let pack: any;
    try {
      pack = JSON.parse(
        (await boundedRead(path, MAX_PACKAGE)).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      fail("作品包格式不正确");
    }
    if (
      !pack ||
      !["xiaoshuo-project", "xiaoshuo-recovery"].includes(pack.format) ||
      ![1, 2, 3, 4, 5, 6, 7].includes(pack.version) ||
      !pack.payload ||
      pack.sha256 !== digest(pack.payload)
    )
      fail("作品包版本或完整性校验失败");
    if(pack.format === "xiaoshuo-recovery" && pack.payload.schemaVersion !== pack.version) fail("恢复包版本与数据不一致");
    // Verify the original digest first, then normalize legacy packages.
    if (pack.version < 3) {
      if (pack.version === 1 && pack.payload.conversations === undefined) pack.payload.conversations = [];
      pack.payload.syncJobs = [];
      pack.payload.syncBatches = [];
      // Older formats did not define synchronization metadata. Never treat
      // unknown v1/v2 fields as authoritative bindings or jobs.
      for (const p of pack.payload.projects ?? [])
        for (const doc of Object.values(p.authoring?.documents ?? {}) as any[]) {
          delete doc.sync;
          if (Array.isArray(doc.history)) for (const h of doc.history) delete h.batchId;
        }
      for (const n of pack.payload.notes ?? []) {
        delete n.archived; delete n.syncManaged; delete n.supplementStage;
      }
      if (pack.format === "xiaoshuo-recovery") pack.payload.schemaVersion = 3;
    }
    if (pack.version < 4) {
      pack.payload.readingWorkspaces = [];
      pack.payload.revisionJobs = [];
      if (pack.format === "xiaoshuo-recovery") pack.payload.schemaVersion = 4;
    }
    if (pack.version < 5) {
      pack.payload.writingJobs = [];
      if (pack.format === "xiaoshuo-recovery") pack.payload.schemaVersion = 5;
    }
    const s = pack.payload as Portable;
    if(pack.version<6){pack.payload.storyRecords=[];pack.payload.storyJobs=[];if(pack.format==="xiaoshuo-recovery")pack.payload.schemaVersion=6;}
    if(pack.version<7){pack.payload.scenePlans=[];pack.payload.sceneJobs=[];if(pack.format==="xiaoshuo-recovery")pack.payload.schemaVersion=7;}
    if (pack.format === "xiaoshuo-recovery") validateRecovery(s);
    else validatePortable(s);
    return this.importPayload(s);
  }
  private importPayload(s: Portable): string {
    const ids = new Map<string, string>();
    // Preserve the source validity decision before identity remapping.
    const sourceState={...s,schemaVersion:7,profiles:[]} as AppState;
    const currentStoryTasks=new Set(s.tasks.filter(t=>{
      const stamp=(t.requestSnapshot as any)?.context?.storyStamp;
      return stamp&&storyStampCurrent(sourceState,t.projectId,stamp);
    }).map(t=>t.id));
    const currentSceneStamps=new Set<string>();
    for(const p of s.scenePlans)for(const f of [p,...p.history])if(storyStampCurrent(sourceState,f.projectId,f.storyStamp))currentSceneStamps.add(`${p.id}:${f.revision}`);
    const currentSceneRevisions=new Set(s.revisionJobs.filter(j=>j.sceneSource?.storyStamp&&s.scenePlans.some(p=>p.id===j.sceneSource!.id&&p.revision===j.sceneSource!.revision)&&storyStampCurrent(sourceState,j.projectId,j.sceneSource.storyStamp)).map(j=>j.id));
    const currentSceneJobs=new Set(s.sceneJobs.filter(j=>storyStampCurrent(sourceState,j.projectId,j.storyStamp)).map(j=>j.id));
    for (const table of tables)
      for (const r of s[table]) ids.set(r.id, randomUUID());
    for(const p of s.scenePlans)for(const f of [p,...p.history])for(const c of f.cards)if(!ids.has(c.id))ids.set(c.id,randomUUID());
    for(const p of [...s.scenePlans,...s.sceneJobs])for(const f of "history" in p?[p,...p.history]:[p]){
      for(const ref of f.sources)if(!ids.has(ref.id))ids.set(ref.id,randomUUID());
    }
    for (const w of s.readingWorkspaces) {
      w.annotations.forEach(a => { remapReadingId(a.id); });
      w.volumes.forEach(v => { remapReadingId(v.id); });
    }
    for (const j of s.revisionJobs) {
      j.noteSources?.forEach(n => remapReadingId(n.id));
      j.notes.forEach(n => { if (n.id) remapReadingId(n.id); });
    }
    function remapReadingId(id: string) { if (!ids.has(id)) ids.set(id, randomUUID()); }
    // Deleted notes can still be mentioned in historic conversation responses.
    // Give those historical identities fresh ids too, without recreating the notes.
    for (const t of s.conversations) for (const n of t.response?.notes ?? []) if (n.id && !ids.has(n.id)) ids.set(n.id, randomUUID());
    // Deleted historical sources also receive fresh identities in the imported copy.
    for (const record of [...s.conversations, ...s.writingJobs]) for (const ref of record.contextReferences ?? [])
      if (!ids.has(ref.source.id)) ids.set(ref.source.id, randomUUID());
    for(const r of s.storyRecords) for(const frame of [r,r.accepted,...r.history,...r.history.map(h=>h.accepted)].filter(Boolean)) {
      for(const e of frame!.evidence)if(!ids.has(e.chapterId))ids.set(e.chapterId,randomUUID());
      if(frame!.entityNoteId&&!ids.has(frame!.entityNoteId))ids.set(frame!.entityNoteId,randomUUID());
      if(frame!.origin.id&&!ids.has(frame!.origin.id))ids.set(frame!.origin.id,randomUUID());
    }
    const remap = (id: string) => {
      if (!ids.has(id)) ids.set(id, randomUUID());
      return ids.get(id)!;
    };
    // Allocate block and historical note identities before any recursive
    // remapping so references remain consistent even when a note was deleted.
    const registerBindings = (items: StageBinding[]) => items.forEach(b => { remap(b.id); if (b.noteId) remap(b.noteId); });
    const registerNote = (n: Note) => { remap(n.id); n.sources.forEach(r => remap(r.id)); };
    for (const p of s.projects) for (const doc of Object.values(p.authoring?.documents ?? {})) {
      if (doc.sync) registerBindings(doc.sync.bindings);
    }
    for (const j of s.syncJobs) {
      j.baseNoteRevisions.forEach(n => remap(n.id));
      j.proposal?.blocks.forEach(b => { if (b.id) remap(b.id); if (b.noteId) remap(b.noteId); });
      j.proposal?.removeNoteIds?.forEach(remap);
      j.conflicts.forEach(c => { remap(c.blockId); c.noteIds.forEach(remap); });
    }
    for (const b of s.syncBatches) for (const snap of [b.before, b.after]) {
      registerBindings(snap.bindings); snap.notes.forEach(registerNote);
    }
    for (const t of s.conversations) for (const a of t.response?.artifacts ?? []) {
      a.blocks?.forEach(b => { if (b.id) remap(b.id); if (b.noteId) remap(b.noteId); });
      a.removeNoteIds?.forEach(remap);
    }
    const sources = (items: SourceRevision[]) =>
      items.map((ref) => ({ ...ref, id: remap(ref.id) }));
    const newId = s.projects.length
      ? remap(s.projects[0].id)
      : s.materials.length
        ? remap(s.materials[0].id)
        : "";
    if (!newId) fail("恢复包没有可导入的内容");
    const nested = (x: any, key = ""): any => {
      if (Array.isArray(x)) return x.map(value => nested(value, key));
      if (x && typeof x === "object")
        return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, nested(v, k)]));
      // Identity-looking prose is still prose. Only reference properties and
      // reference lists participate in remapping.
      return typeof x === "string" && (key === "id" || key.endsWith("Id") || key.endsWith("Ids")) && ids.has(x) ? remap(x) : x;
    };
    const bindings = (items: StageBinding[]) => items.map(b => ({ ...b, id: remap(b.id), ...(b.noteId ? { noteId: remap(b.noteId) } : {}) }));
    const note = (n: Note): Note => ({ ...n, id: remap(n.id), projectId: remap(n.projectId), sources: sources(n.sources) });
    const bundle = (b: StageBundle): StageBundle => ({ ...b, blocks: b.blocks.map(block => ({ ...block, ...(block.id ? { id: remap(block.id) } : {}), ...(block.noteId ? { noteId: remap(block.noteId) } : {}) })), ...(b.removeNoteIds ? { removeNoteIds: b.removeNoteIds.map(remap) } : {}) });
    const snapshot = (snap: StageSyncSnapshot): StageSyncSnapshot => ({ ...snap, notes: snap.notes.map(note), bindings: bindings(snap.bindings) });
    const authoring = (value: AuthoringState): AuthoringState => ({ ...value, documents: Object.fromEntries(Object.entries(value.documents).map(([stage, doc]) => [stage, {
      ...doc,
      history: doc.history.map(h => ({ ...h, ...(h.batchId ? { batchId: remap(h.batchId) } : {}) })),
      ...(doc.sync ? { sync: { ...doc.sync, bindings: bindings(doc.sync.bindings),
        ...(doc.sync.jobId ? { jobId: remap(doc.sync.jobId) } : {}),
        ...(doc.sync.batchId ? { batchId: remap(doc.sync.batchId) } : {}),
        status: ["running", "pending"].includes(doc.sync.status) ? "pending" : doc.sync.status,
      } } : {}),
    }])) });
    this.store.transaction(() => {
      for (const p of s.projects)
        this.store.put("projects", {
          ...p,
          id: remap(p.id),
          title: p.title + "（副本）",
          ...(p.authoring ? { authoring: authoring(p.authoring) } : {}),
        });
      for (const n of s.notes)
        this.store.put("notes", {
          ...n,
          id: remap(n.id),
          projectId: remap(n.projectId),
          sources: sources(n.sources),
        });
      for (const c of s.chapters)
        this.store.put("chapters", {
          ...c,
          id: remap(c.id),
          projectId: remap(c.projectId),
        });
      for (const v of s.versions)
        this.store.put("versions", {
          ...v,
          id: remap(v.id),
          projectId: remap(v.projectId),
          chapterId: remap(v.chapterId),
          sourceRevisions: sources(v.sourceRevisions),
          ...(v.taskId ? { taskId: remap(v.taskId) } : {}),
          ...(v.restoredFrom ? { restoredFrom: remap(v.restoredFrom) } : {}),
        });
      for (const m of s.materials)
        this.store.put("materials", {
          ...m,
          id: remap(m.id),
          projectReferences: m.projectReferences.map((r) => ({
            ...r,
            projectId: remap(r.projectId),
          })),
        });
      for (const t of s.tasks)
        this.store.put("tasks", {
          ...t,
          id: remap(t.id),
          projectId:
            t.projectId === "@connection" ? "@connection" : remap(t.projectId),
          sourceRevisions: sources(t.sourceRevisions),
          requestSnapshot: nested(t.requestSnapshot),
          result: nested(t.result),
          status: ["running", "waiting"].includes(t.status)
            ? "interrupted"
            : t.status,
        });
      for (const i of s.issues)
        this.store.put("issues", {
          ...i,
          id: remap(i.id),
          projectId: remap(i.projectId),
          ...(i.chapterId ? { chapterId: remap(i.chapterId) } : {}),
          evidence: i.evidence.map((e) => ({
            ...e,
            source: sources([e.source])[0],
            ...(e.candidateVersionId
              ? { candidateVersionId: remap(e.candidateVersionId) }
              : {}),
          })),
        });
      for (const j of s.syncJobs) {
        const { profileId, ...job } = j;
        this.store.put("syncJobs", { ...job, id: remap(j.id), projectId: remap(j.projectId),
          baseNoteRevisions: j.baseNoteRevisions.map(n => ({ ...n, id: remap(n.id) })),
          ...(j.proposal ? { proposal: bundle(j.proposal) } : {}),
          conflicts: j.conflicts.map(c => ({ ...c, blockId: remap(c.blockId), noteIds: c.noteIds.map(remap) })),
          status: ["pending", "running"].includes(j.status) ? "interrupted" : j.status,
        });
      }
      for (const b of s.syncBatches) this.store.put("syncBatches", { ...b, id: remap(b.id), projectId: remap(b.projectId), jobId: remap(b.jobId), before: snapshot(b.before), after: snapshot(b.after) });
      for (const t of s.conversations) {
        const { profileId, ...portable } = t;
        this.store.put("conversations", { ...nested(portable), status: t.status === "running" ? "interrupted" : t.status });
      }
      for (const w of s.readingWorkspaces) this.store.put("readingWorkspaces", nested(w));
      for (const j of s.revisionJobs) {
        const { profileId, ...job } = j;
        const original = s.projects.find(p => p.id === j.projectId)!;
        const originalDigest = createHash("sha256").update(JSON.stringify([original.title, original.background, original.genre, original.style, original.pace])).digest("hex");
        const imported = this.store.get("projects", remap(j.projectId))!;
        const sourceProjectDigest = j.sourceProjectDigest === originalDigest
          ? createHash("sha256").update(JSON.stringify([imported.title, imported.background, imported.genre, imported.style, imported.pace])).digest("hex")
          : j.sourceProjectDigest;
        this.store.put("revisionJobs", { ...nested(job), ...(sourceProjectDigest ? { sourceProjectDigest } : {}), status: j.status === "running" ? "interrupted" : j.status });
      }
      for (const j of s.writingJobs) {
        const { profileId, checkingProfileId, reviewSourceDigest, checkCursor, checkSourceDigest, checkIssues, ...job } = j;
        this.store.put("writingJobs", { ...nested(job), status: j.status === "running" ? "interrupted" : j.status });
      }
      for(const p of s.scenePlans)this.store.put("scenePlans",nested(p));
      for(const j of s.sceneJobs){const {profileId,...job}=j;this.store.put("sceneJobs",{...nested(job),status:j.status==="running"?"interrupted":j.status});}
      for(const r of s.storyRecords)this.store.put("storyRecords",nested(r));
      for(const j of s.storyJobs){const {profileId,...job}=j;this.store.put("storyJobs",{...nested(job),status:j.status==="running"?"interrupted":j.status});}
      for (const original of s.projects) this.reprojectImportedProject(remap(original.id), original.title);
      // All records and evidence now have their final imported identities.
      // Refresh only previously current stamps; stale tasks must remain blocked.
      const importedState=this.store.snapshot();
      for(const original of s.scenePlans){
        const imported=this.store.get("scenePlans",remap(original.id))!;
        for(const frame of [imported,...imported.history])if(currentSceneStamps.has(`${original.id}:${frame.revision}`))frame.storyStamp=storyContext(importedState,imported.projectId,frame.storyStamp.beforeOrdinal,frame.storyStamp.writingJobId).stamp;
        this.store.put("scenePlans",imported);
      }
      for(const original of s.sceneJobs)if(currentSceneJobs.has(original.id)){
        const j=this.store.get("sceneJobs",remap(original.id))!;this.store.put("sceneJobs",{...j,storyStamp:storyContext(importedState,j.projectId,j.storyStamp.beforeOrdinal,j.storyStamp.writingJobId).stamp});
      }

      for(const original of s.revisionJobs)if(currentSceneRevisions.has(original.id)){
        const imported=this.store.get("revisionJobs",remap(original.id))!,stamp=imported.sceneSource!.storyStamp!;
        this.store.put("revisionJobs",{...imported,sceneSource:{...imported.sceneSource!,storyStamp:storyContext(importedState,imported.projectId,stamp.beforeOrdinal,stamp.writingJobId).stamp}});
      }
      for(const original of s.tasks){
        if(!currentStoryTasks.has(original.id))continue;
        const imported=this.store.get("tasks",remap(original.id))!;
        const request=structuredClone(imported.requestSnapshot) as any;
        const stamp=request.context.storyStamp;
        request.context.storyStamp=storyContext(importedState,imported.projectId,stamp.beforeOrdinal,stamp.writingJobId).stamp;
        this.store.put("tasks",{...imported,requestSnapshot:request});
      }
      // A renamed imported copy may re-render synchronized planning documents.
      // Rebase only fingerprints that were current in the source package.
      for (const original of s.revisionJobs) {
        const sourceProject = s.projects.find(p => p.id === original.projectId)!;
        if (original.sourceAuthoringDigest && original.sourceAuthoringDigest === authoringDigest(sourceProject)) {
          const imported = this.store.get("revisionJobs", remap(original.id))!;
          this.store.put("revisionJobs", { ...imported, sourceAuthoringDigest: authoringDigest(this.store.get("projects", remap(original.projectId))!) });
        }
      }
    });
    return newId;
  }
  private reprojectImportedProject(projectId: string, originalTitle: string): void {
    const state = this.store.snapshot(), project = state.projects.find(p => p.id === projectId)!;
    if (!project.authoring) return;
    const workflow = structuredClone(project.authoring);
    const projectNotes = state.notes.filter(n => n.projectId === projectId);
    const fields = (p: Project): StageSyncSnapshot["fields"] => ({ title: p.title, genre: p.genre, background: p.background, style: p.style, pace: p.pace });
    let changed = false;
    for (const stage of planningStages) {
      const old = workflow.documents[stage];
      // Unresolved drafts retain their exact text and last committed baseline.
      if (old?.sync?.status !== "synced") continue;
      const content = renderStage(old.sync.bindings, state, projectId);
      if (content === old.content) continue;
      if (content.length > 30000) fail("导入副本改名后的阶段全文超过长度限制，原作品包保留");
      const now = new Date().toISOString();
      const jobId = randomUUID(), batchId = randomUUID();
      const boundIds = new Set(old.sync.bindings.flatMap(b => b.noteId ? [b.noteId] : []));
      const notes = projectNotes.filter(n => boundIds.has(n.id));
      // Imported batches are historical evidence. Record the copy rename as
      // a new local auxiliary change instead of altering their text or fields.
      const batch: StageSyncBatch = {
        id: batchId, revision: 1, createdAt: now, updatedAt: now, projectId, stage, jobId, origin: "auxiliary",
        before: { fields: fields({ ...project, title: originalTitle }), notes, bindings: old.sync.bindings, content: old.content },
        after: { fields: fields(project), notes, bindings: old.sync.bindings, content },
      };
      writeDocument(workflow, stage, content);
      const doc = workflow.documents[stage]!;
      doc.sync = { status: "synced", bindings: old.sync.bindings, lastSyncedContent: content, lastSyncedRevision: doc.revision, jobId, batchId };
      const job: StageSyncJob = {
        id: jobId, revision: 1, createdAt: now, updatedAt: now, projectId, stage,
        status: "succeeded", documentRevision: doc.revision, sourceContent: content,
        baseProjectRevision: project.revision, baseNoteRevisions: projectNotes.map(n => ({ id: n.id, revision: n.revision })),
        conflicts: [], summary: ["导入副本改名已同步到阶段全文"], calls: 0, usage: null,
      };
      this.store.put("syncJobs", job); this.store.put("syncBatches", batch);
      changed = true;
    }
    if (changed) {
      validateAuthoring(workflow);
      this.store.put("projects", { ...project, authoring: workflow, revision: project.revision + 1, updatedAt: new Date().toISOString() });
    }
  }
}
function validatePortable(s: any): asserts s is Portable {
  validatePublicJson(s);
  if (!s || Object.keys(s).sort().join(",") !== [...tables].sort().join(","))
    fail("作品包包含不支持的数据");
  for (const table of tables)
    if (!Array.isArray(s[table]) || s[table].length > 100000)
      fail("作品包数据数量不正确");
  if (s.projects.length !== 1) fail("作品包必须包含一部作品");
  const project = s.projects[0];
  const pid = project.id;
  const ids = new Set<string>();
  const str = (x: unknown) => {
    if (typeof x !== "string") fail("作品包文本格式不正确");
  };
  const integer = (x: unknown) => {
    if (!Number.isSafeInteger(x) || Number(x) < 1) fail("作品包编号格式不正确");
  };
  for (const table of tables)
    for (const r of s[table]) {
      if (!r || typeof r !== "object") fail("作品包记录格式不正确");
      str(r.id);
      if (!r.id || ids.has(r.id)) fail("作品包记录编号重复");
      ids.add(r.id);
      if (table !== "versions") {
        integer(r.revision);
        for (const k of ["createdAt", "updatedAt"])
          if (!Number.isFinite(Date.parse(r[k]))) fail("作品包时间格式不正确");
      }
      if (table !== "projects" && table !== "materials" && r.projectId !== pid)
        fail("作品包跨作品引用不正确");
    }
  for (const k of ["title", "background", "genre", "style", "pace"])
    str(project[k]);
  integer(project.targetWords);
  integer(project.chapterWords);
  if (typeof project.archived !== "boolean") fail("作品状态格式不正确");
  if (project.authoring !== undefined) validateAuthoring(project.authoring);
  const chapters = new Set(s.chapters.map((c: any) => c.id));
  const ordinals = new Set();
  const versions = new Set(s.versions.map((v: any) => v.id));
  for (const n of s.notes) validatePortableNote(n);
  validateSyncPortable(s);
  validateSyncOwnership(s);
  for (const c of s.chapters) {
    integer(c.ordinal);
    if (ordinals.has(c.ordinal)) fail("作品包章节序号重复");
    ordinals.add(c.ordinal);
    for (const k of ["title", "content", "style", "pace"]) str(c[k]);
    if (
      !["draft", "confirmed"].includes(c.status) ||
      typeof c.needsReview !== "boolean"
    )
      fail("章节状态不正确");
    if (c.writingStage !== undefined && !["opening", "complete"].includes(c.writingStage)) fail("章节创作进度不正确");
  }
  for (const v of s.versions) {
    if (
      !chapters.has(v.chapterId) ||
      (v.restoredFrom && !versions.has(v.restoredFrom))
    )
      fail("作品包版本引用不正确");
    integer(v.chapterRevision);
    for (const k of ["title", "content", "style", "pace"]) str(v[k]);
    validateSources(v.sourceRevisions);
    if (
      !["create", "save", "confirm", "restore", "ai-candidate"].includes(
        v.reason,
      ) ||
      !["draft", "confirmed"].includes(v.status) ||
      !Number.isFinite(Date.parse(v.createdAt))
    )
      fail("正文版本格式不正确");
    if (v.writingStage !== undefined && !["opening", "complete"].includes(v.writingStage)) fail("版本创作进度不正确");
  }
  for (const m of s.materials) {
    for (const k of ["title", "source", "content", "explanation"]) str(m[k]);
    if (
      !["expression", "plot"].includes(m.type) ||
      typeof m.approved !== "boolean" ||
      !Array.isArray(m.projectReferences) ||
      m.projectReferences.length !== 1 ||
      m.projectReferences[0].projectId !== pid
    )
      fail("作品包素材引用不正确");
    const snap = m.projectReferences[0].snapshot;
    if (!snap) fail("作品包缺少引用素材快照");
    for (const k of ["title", "source", "content", "explanation"]) str(snap[k]);
    integer(snap.revision);
    if (
      !["expression", "plot"].includes(snap.type) ||
      snap.approved !== true ||
      !Number.isFinite(Date.parse(m.projectReferences[0].linkedAt))
    )
      fail("作品包素材快照不正确");
  }
  for (const t of s.tasks) {
    validateTask(t);
    validateTaskReferences(t, s);
  }
  for (const i of s.issues) {
    validateIssue(i);
    if (i.chapterId && !chapters.has(i.chapterId))
      fail("作品包检查问题引用不正确");
  }
  const turns = new Set(s.conversations.map((t: any) => t.id));
  validateRecallOwnership(s);
  for (const t of s.conversations) {
    validateConversationTurn(t);
    if ([...t.chapterIds, ...(t.chapterId ? [t.chapterId] : []), ...(t.proposal?.chapterIds ?? []), ...(t.response?.proposal?.chapterIds ?? []), ...(t.response?.chapters ?? []).flatMap((c: any) => c.id ? [c.id] : [])].some(id => !chapters.has(id)) || (t.proposalTurnId && !turns.has(t.proposalTurnId))) fail("作品包对话引用不正确");
  }
  validateStoryOwnership(s);
  validateSceneOwnership(s);
  validateReadingPayload(s);
  validateWritingPayload(s);
}

function validateRecovery(s: any): void {
  validatePublicJson(s);
  if (
    !s ||
    s.schemaVersion !== 7 ||
    Object.keys(s).sort().join(",") !==
      ["schemaVersion", ...tables].sort().join(",")
  )
    fail("恢复包格式不正确");
  for (const table of tables)
    if (!Array.isArray(s[table]) || s[table].length > 100000)
      fail("恢复包数量不正确");
  const ids = new Set();
  const projects = new Set(s.projects.map((p: any) => p.id));
  for (const table of tables)
    for (const r of s[table]) {
      if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id))
        fail("恢复包记录编号重复或错误");
      ids.add(r.id);
      if (
        table !== "projects" &&
        table !== "materials" &&
        !projects.has(r.projectId) &&
        !(
          table === "tasks" &&
          r.projectId === "@connection" &&
          r.kind === "connection" &&
          Array.isArray(r.sourceRevisions) &&
          r.sourceRevisions.length === 0
        )
      )
        fail("恢复包包含未知作品引用");
    }
  for (const task of s.tasks) {
    validateTask(task);
    validateTaskReferences(task, s);
  }
  validateRecallOwnership(s);
  validateStoryOwnership(s);
  validateSceneOwnership(s);
  for (const project of s.projects) {
    const pid = project.id;
    validatePortable({
      projects: [project],
      notes: s.notes.filter((r: any) => r.projectId === pid),
      chapters: s.chapters.filter((r: any) => r.projectId === pid),
      versions: s.versions.filter((r: any) => r.projectId === pid),
      tasks: s.tasks.filter((r: any) => r.projectId === pid),
      issues: s.issues.filter((r: any) => r.projectId === pid),
      conversations: s.conversations.filter((r: any) => r.projectId === pid),
      syncJobs: s.syncJobs.filter((r: any) => r.projectId === pid),
      syncBatches: s.syncBatches.filter((r: any) => r.projectId === pid),
      readingWorkspaces: s.readingWorkspaces.filter((r: any) => r.projectId === pid),
      revisionJobs: s.revisionJobs.filter((r: any) => r.projectId === pid),
      writingJobs: s.writingJobs.filter((r: any) => r.projectId === pid),
      scenePlans:s.scenePlans.filter((r:any)=>r.projectId===pid),
      sceneJobs:s.sceneJobs.filter((r:any)=>r.projectId===pid),
      storyRecords:s.storyRecords.filter((r:any)=>r.projectId===pid),
      storyJobs:s.storyJobs.filter((r:any)=>r.projectId===pid),
      materials: s.materials
        .filter(
          (m: any) =>
            Array.isArray(m.projectReferences) &&
            m.projectReferences.some((r: any) => r.projectId === pid),
        )
        .map((m: any) => ({
          ...m,
          projectReferences: m.projectReferences.filter(
            (r: any) => r.projectId === pid,
          ),
        })),
    });
  }
  validateSyncOwnership(s);
  for (const m of s.materials) {
    if (
      !Number.isSafeInteger(m.revision) ||
      m.revision < 1 ||
      !Number.isFinite(Date.parse(m.createdAt)) ||
      !Number.isFinite(Date.parse(m.updatedAt)) ||
      !["expression", "plot"].includes(m.type) ||
      typeof m.approved !== "boolean" ||
      ["title", "source", "content", "explanation"].some(
        (k) => typeof m[k] !== "string",
      ) ||
      !Array.isArray(m.projectReferences) ||
      m.projectReferences.some((r: any) => !r || !projects.has(r.projectId)) ||
      new Set(m.projectReferences.map((r: any) => r.projectId)).size !==
        m.projectReferences.length
    )
      fail("恢复包素材格式或引用不正确");
  }
}

function validateRecallOwnership(s: Portable): void {
  const chapters = new Map(s.chapters.map(c => [c.id,c]));
  for (const record of [...s.conversations, ...s.writingJobs]) {
    if (record.contextReferences === undefined) continue;
    validateRecallReferences(record.contextReferences);
    for (const ref of record.contextReferences) {
      const c = chapters.get(ref.source.id);
      if (c && (c.projectId !== record.projectId || ref.source.revision > c.revision ||
        ref.source.revision === c.revision && c.content.slice(ref.start,ref.end) !== ref.excerpt))
        fail("远章原文引用与作品或来源版本不一致");
    }
  }
}

function validateReadingPayload(s: Portable): void {
  const pid = s.projects[0].id;
  const chapters = new Map(s.chapters.map(c => [c.id, c]));
  const versions = new Map(s.versions.map(v => [v.id, v]));
  const notes = new Map(s.notes.map(n => [n.id, n]));
  const check = (ok: unknown, message = "阅读与改稿资料格式不正确") => { if (!ok) fail(message); };
  const int = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
  const string = (value: unknown) => typeof value === "string";
  const meta = (r: any) => check(r && string(r.id) && r.id && int(r.revision, 1) && Number.isFinite(Date.parse(r.createdAt)) && Number.isFinite(Date.parse(r.updatedAt)));
  const identifiers = new Set<string>();
  const unique = (id: string) => { check(string(id) && id && !identifiers.has(id), "阅读资料编号重复"); identifiers.add(id); };
  const anchor = (a: any) => {
    check(a && chapters.has(a.chapterId) && int(a.revision, 1) && int(a.start) && int(a.end) && a.end > a.start && string(a.quote) && a.quote.length === a.end - a.start, "批注原文位置不正确");
    const current = chapters.get(a.chapterId)!;
    const source = current.revision === a.revision ? current : s.versions
      .filter(v => v.chapterId === a.chapterId && v.chapterRevision <= a.revision && v.reason !== "ai-candidate")
      .sort((a, b) => b.chapterRevision - a.chapterRevision || b.createdAt.localeCompare(a.createdAt))[0];
    check(source && source.content.slice(a.start, a.end) === a.quote, "批注来源版本或原文不正确");
    return source!;
  };
  check(s.readingWorkspaces.length <= 1, "一部作品只能包含一份阅读工作区");
  for (const w of s.readingWorkspaces) {
    meta(w); check(w.projectId === pid); check(Array.isArray(w.annotations) && Array.isArray(w.reviews) && Array.isArray(w.volumes));
    for (const a of w.annotations) {
      meta(a); unique(a.id); check(chapters.has(a.chapterId) && a.anchor?.chapterId === a.chapterId && string(a.text) && a.text.length <= 10000 && ["open", "resolved"].includes(a.status));
      const source = anchor(a.anchor);
      if (a.contentHash !== undefined) check(a.contentHash === createHash("sha256").update(source.content).digest("hex"), "批注完整来源不正确");
    }
    const reviewed = new Set<string>();
    for (const r of w.reviews) {
      const v = versions.get(r.versionId);
      check(chapters.has(r.chapterId) && !reviewed.has(r.chapterId) && int(r.revision, 1) && v?.chapterId === r.chapterId && v.chapterRevision <= r.revision && Number.isFinite(Date.parse(r.reviewedAt)), "审阅基准版本不正确");
      if (r.contentHash !== undefined) check(r.contentHash === createHash("sha256").update(v!.content).digest("hex"), "审阅基准内容不正确");
      reviewed.add(r.chapterId);
    }
    const ranges: { fromOrdinal: number; toOrdinal: number }[] = [];
    for (const v of w.volumes) {
      unique(v.id); check(string(v.title) && v.title.trim() && int(v.fromOrdinal, 1) && int(v.toOrdinal, 1) && v.toOrdinal >= v.fromOrdinal);
      check(!ranges.some(r => r.fromOrdinal <= v.toOrdinal && v.fromOrdinal <= r.toOrdinal), "分卷范围重叠"); ranges.push(v);
    }
    if (w.position) check(chapters.has(w.position.chapterId) && int(w.position.offset) && ["reading", "review"].includes(w.position.mode));
  }
  for (const j of s.revisionJobs) {
    validateRevisionJob(j);
    meta(j); check(j.projectId === pid && string(j.text) && int(j.tokenBudget, 1) && int(j.calls) && int(j.sourceProjectRevision, 1));
    check(["selection", "chapter", "chapters", "all"].includes(j.scope) && ["running", "paused", "interrupted", "cancelled", "failed", "awaiting-author", "completed"].includes(j.status));
    check(Array.isArray(j.chapterIds) && Array.isArray(j.checkedChapterIds) && Array.isArray(j.annotationIds) && Array.isArray(j.candidates) && Array.isArray(j.notes) && Array.isArray(j.warnings));
    check(new Set(j.chapterIds).size === j.chapterIds.length && j.chapterIds.every(id => chapters.has(id)), "改稿范围引用不正确");
    check(new Set(j.checkedChapterIds).size === j.checkedChapterIds.length && j.checkedChapterIds.every(id => j.chapterIds.includes(id)), "改稿检查覆盖范围不正确");
    check(j.annotationIds.every(id => s.readingWorkspaces.some(w => w.annotations.some(a => a.id === id))), "改稿批注引用不正确");
    if (j.selection) anchor(j.selection);
    const candidateIds = new Set<string>();
    for (const c of j.candidates) {
      check(j.chapterIds.includes(c.chapterId) && !candidateIds.has(c.chapterId) && int(c.sourceRevision, 1) && string(c.title) && string(c.baseContent) && string(c.content) && ["pending", "accepted", "rejected"].includes(c.status), "改稿候选引用不正确");
      candidateIds.add(c.chapterId);
    }
    for (const n of j.notes) check((!n.id || notes.has(n.id) || j.noteSources?.some(s => s.id === n.id)) && string(n.title) && string(n.body) && (!n.sourceRevision || int(n.sourceRevision, 1)), "改稿资料引用不正确");
    if (j.usage !== null) check(j.usage && typeof j.usage.estimated === "boolean" && [j.usage.inputTokens, j.usage.outputTokens, j.usage.totalTokens].every(t => t === null || int(t)));
    check(["pending", "accepted", "rejected"].includes(j.materialsStatus) && j.warnings.every(string) && string(j.reply));
  }
}

function validateWritingPayload(state: Portable): void {
  const projectId = state.projects[0].id;
  const chapters = new Map(state.chapters.map(chapter => [chapter.id, chapter]));
  const notes = new Map(state.notes.map(note => [note.id, note]));
  const revisions = new Map(state.revisionJobs.map(job => [job.id, job]));
  for (const job of state.writingJobs) {
    validateWritingJob(job);
    if (job.projectId !== projectId) fail("连续写作任务跨作品引用不正确");
    for (const progress of job.chapters) if (progress.chapterId) {
      const chapter = chapters.get(progress.chapterId);
      if (!chapter || chapter.projectId !== projectId || chapter.ordinal !== progress.ordinal || (progress.checkedRevision !== undefined && progress.checkedRevision > chapter.revision))
        fail("连续写作任务章节引用不正确");
    }
    for (const id of job.revisionJobIds) if (revisions.get(id)?.projectId !== projectId) fail("连续写作待审稿引用不正确");
    for (const issue of [...job.issues, ...(job.checkIssues ?? [])]) {
      if (issue.chapterId && chapters.get(issue.chapterId)?.projectId !== projectId) fail("连续写作问题章节引用不正确");
      for (const { source } of issue.evidence) {
        const record = source.kind === "project" ? state.projects.find(project => project.id === source.id)
          : source.kind === "chapter" ? chapters.get(source.id) : notes.get(source.id);
        if (!record || (source.kind === "project" ? record.id !== projectId : !("projectId" in record) || record.projectId !== projectId) || source.revision > record.revision)
          fail("连续写作问题来源引用不正确");
      }
    }
  }
}

function validateTaskReferences(task: any, state: Portable): void {
  const request = task.requestSnapshot,
    command = request.command;
  const chapters = new Map(
    state.chapters.map((chapter) => [chapter.id, chapter]),
  );
  const notes = new Map(state.notes.map((note) => [note.id, note]));
  const versions = new Map(
    state.versions.map((version) => [version.id, version]),
  );
  const chapter = (id: string) => {
    const value = chapters.get(id);
    if (!value || value.projectId !== task.projectId)
      fail("任务章节引用不属于该作品");
  };
  for (const id of [
    ...(command.chapterIds ?? []),
    ...(command.includeDraftIds ?? []),
  ])
    chapter(id);
  for (const id of command.noteIds ?? []) {
    const value = notes.get(id);
    if (value && value.projectId !== task.projectId)
      fail("任务设定引用不属于该作品");
  }
  // Deleted historical notes may be absent; their immutable text remains in the
  // request. A reference to an extant record must never cross work ownership.
  for (const source of task.sourceRevisions) {
    const value =
      source.kind === "chapter"
        ? chapters.get(source.id)
        : source.kind === "note"
          ? notes.get(source.id)
          : undefined;
    if (value && value.projectId !== task.projectId)
      fail("任务来源引用不属于该作品");
  }
  for (const candidate of task.result.candidates ?? []) {
    chapter(candidate.chapterId);
    if (candidate.versionId) {
      const version = versions.get(candidate.versionId);
      if (
        !version ||
        version.reason !== "ai-candidate" ||
        version.chapterId !== candidate.chapterId ||
        version.projectId !== task.projectId ||
        version.taskId !== task.id ||
        version.content !== candidate.text
      )
        fail("任务候选版本引用不正确");
    }
  }
  for (const document of request.context.documents) {
    if (document.candidateId) {
      const version = versions.get(document.candidateId);
      if (
        !version ||
        document.source.kind !== "chapter" ||
        version.chapterId !== document.source.id ||
        version.projectId !== task.projectId
      )
        fail("任务来源候选版本引用不正确");
    }
  }
  const issues = new Map(state.issues.map((issue) => [issue.id, issue]));
  for (const id of task.result.issueIds ?? []) {
    const issue = issues.get(id);
    if (!issue || issue.projectId !== task.projectId)
      fail("任务检查问题引用不正确");
  }
}

const portableNoteTypes = ["character", "world", "location", "storyline", "outline", "chapterOutline", "summary", "timeline", "knowledge", "foreshadowing", "supplement"];
const syncStages = ["overview", "settings", "outline"];
const syncFields: Record<string, string[]> = { overview: ["title", "genre", "background"], settings: ["style", "pace"], outline: [] };
const syncNoteTypes: Record<string, string[]> = { overview: ["supplement"], settings: ["character", "world", "location", "supplement"], outline: ["storyline", "outline", "chapterOutline", "supplement"] };
function syncObject(x: any): void { if (!x || typeof x !== "object" || Array.isArray(x)) fail("同步数据格式不正确"); }
function syncText(x: any): void { if (typeof x !== "string") fail("同步文本格式不正确"); }
function syncId(x: any): void { if (typeof x !== "string" || !x) fail("同步编号格式不正确"); }
function syncInt(x: any, min = 1): void { if (!Number.isSafeInteger(x) || x < min) fail("同步修订或计数格式不正确"); }
function syncArray(x: any): void { if (!Array.isArray(x) || x.length > 100000) fail("同步列表格式不正确"); }
function syncKeys(x: any, keys: string[]): void { syncObject(x); if (Object.keys(x).some(k => !keys.includes(k))) fail("同步数据包含不支持的字段"); }
function syncMeta(x: any): void { syncObject(x); syncId(x.id); syncInt(x.revision); for (const k of ["createdAt", "updatedAt"]) if (!Number.isFinite(Date.parse(x[k]))) fail("同步时间格式不正确"); }
function validatePortableNote(n: any): void {
  syncMeta(n); syncId(n.projectId);
  if (!portableNoteTypes.includes(n.type)) fail("设定类型不正确");
  syncText(n.title); syncText(n.body); validateSources(n.sources);
  if (typeof n.needsReview !== "boolean") fail("设定状态不正确");
  for (const key of ["archived", "syncManaged"]) if (n[key] !== undefined && typeof n[key] !== "boolean") fail("设定归档或同步状态不正确");
  if (n.supplementStage !== undefined && (!syncStages.includes(n.supplementStage) || n.type !== "supplement")) fail("补充设定阶段不正确");
  if (n.type === "supplement" && !syncStages.includes(n.supplementStage)) fail("补充设定缺少所属阶段");
  if (n.history !== undefined) {
    syncArray(n.history);
    for (const h of n.history) {
      syncObject(h); syncInt(h.revision); syncText(h.title); syncText(h.body);
      if (!portableNoteTypes.includes(h.type) || !Number.isFinite(Date.parse(h.createdAt))) fail("设定历史格式不正确");
    }
  }
}
function validateSyncPortable(s: Portable): void {
  const project = s.projects[0], pid = project.id;
  const liveNotes = new Map(s.notes.map(n => [n.id, n]));
  const jobs = new Map(s.syncJobs.map(j => [j.id, j]));
  const batches = new Map(s.syncBatches.map(b => [b.id, b]));
  // supplementStage identifies the primary auxiliary category; a supplement
  // can be shared by several stage bindings within the same project.
  const noteReference = (id: string, stage: string, notes: Map<string, Note>, active: boolean) => {
    syncId(id); const n = notes.get(id);
    if (!n || n.projectId !== pid || (active && n.archived) || !syncNoteTypes[stage].includes(n.type)) fail("同步绑定设定引用不正确");
  };
  const bindings = (items: any, stage: string, notes: Map<string, Note>, active: boolean) => {
    syncArray(items); const ids = new Set(), targets = new Set();
    for (const b of items) {
      syncKeys(b, ["id", "kind", "field", "noteId", "heading"]); syncId(b.id);
      if (ids.has(b.id)) fail("同步块编号重复"); ids.add(b.id);
      if (b.heading !== undefined && typeof b.heading !== "boolean") fail("同步块标题状态不正确");
      if (b.kind === "field") {
        if (!syncFields[stage].includes(b.field) || b.noteId !== undefined) fail("同步字段绑定不正确");
      } else if (b.kind === "note") {
        if (b.field !== undefined) fail("同步设定绑定不正确"); noteReference(b.noteId, stage, notes, active);
      } else fail("同步绑定类型不正确");
      const target = b.kind === "field" ? `field:${b.field}` : `note:${b.noteId}`;
      if (targets.has(target)) fail("同步目标重复绑定"); targets.add(target);
    }
  };
  const jobRef = (id: any, stage: string) => { syncId(id); const j = jobs.get(id); if (!j || j.stage !== stage || j.projectId !== pid) fail("同步任务引用不正确"); };
  const batchRef = (id: any, stage: string) => { syncId(id); const b = batches.get(id); if (!b || b.stage !== stage || b.projectId !== pid) fail("同步批次引用不正确"); };
  for (const [stage, doc] of Object.entries(project.authoring?.documents ?? {})) {
    if (doc.sync !== undefined) {
      const d: any = doc.sync;
      syncKeys(d, ["status", "bindings", "lastSyncedContent", "lastSyncedRevision", "jobId", "batchId", "error"]);
      if (!["synced", "pending", "running", "failed", "conflict"].includes(d.status)) fail("同步状态不正确");
      syncText(d.lastSyncedContent); syncInt(d.lastSyncedRevision, 0);
      if (d.lastSyncedRevision > doc.revision) fail("同步修订超过阶段修订");
      bindings(d.bindings, stage, liveNotes, true);
      if (d.jobId !== undefined) jobRef(d.jobId, stage);
      if (d.batchId !== undefined) batchRef(d.batchId, stage);
      if (d.error !== undefined) syncText(d.error);
    }
    for (const h of doc.history) if (h.batchId !== undefined) batchRef(h.batchId, stage);
  }
  for (const job of s.syncJobs) {
    const j: any = job;
    syncKeys(j, ["id", "revision", "createdAt", "updatedAt", "projectId", "stage", "documentRevision", "status", "sourceContent", "baseProjectRevision", "baseNoteRevisions", "proposal", "conflicts", "summary", "calls", "usage", "profileId", "error"]);
    syncMeta(j); if (!syncStages.includes(j.stage) || j.projectId !== pid) fail("同步任务阶段或作品不正确");
    syncInt(j.documentRevision); syncInt(j.baseProjectRevision); syncInt(j.calls, 0); syncText(j.sourceContent);
    if (!["pending", "running", "succeeded", "failed", "conflict", "cancelled", "interrupted"].includes(j.status)) fail("同步任务状态不正确");
    syncArray(j.baseNoteRevisions); const bases = new Set();
    for (const n of j.baseNoteRevisions) { syncKeys(n, ["id", "revision"]); syncId(n.id); syncInt(n.revision); if (bases.has(n.id)) fail("同步依据设定重复"); bases.add(n.id); }
    syncArray(j.conflicts);
    for (const c of j.conflicts) { syncKeys(c, ["blockId", "title", "reason", "noteIds"]); syncId(c.blockId); syncText(c.title); syncText(c.reason); syncArray(c.noteIds); c.noteIds.forEach(syncId); }
    syncArray(j.summary); j.summary.forEach(syncText);
    if (j.error !== undefined) syncText(j.error); if (j.profileId !== undefined) syncId(j.profileId);
    if (j.usage !== null) {
      syncKeys(j.usage, ["inputTokens", "outputTokens", "totalTokens", "estimated"]);
      if (typeof j.usage.estimated !== "boolean") fail("同步用量格式不正确");
      for (const k of ["inputTokens", "outputTokens", "totalTokens"]) if (j.usage[k] !== null) syncInt(j.usage[k], 0);
    }
    if (j.proposal !== undefined) {
      validateBundle(j.proposal);
      const p = j.proposal;
      if (p.stage !== j.stage) fail("同步方案阶段不正确");
      for (const b of p.blocks) if (b.endLine !== undefined && b.endLine > j.sourceContent.split(/\r?\n/).length) fail("同步方案源行范围不正确");
    }
  }
  for (const batch of s.syncBatches) {
    const b: any = batch;
    syncKeys(b, ["id", "revision", "createdAt", "updatedAt", "projectId", "stage", "jobId", "before", "after", "origin"]); syncMeta(b);
    if (!["generation", "draft", "auxiliary", "restore"].includes(b.origin)) fail("同步批次来源不正确");
    if (!syncStages.includes(b.stage) || b.projectId !== pid) fail("同步批次阶段或作品不正确"); jobRef(b.jobId, b.stage);
    for (const snap of [b.before, b.after]) {
      syncKeys(snap, ["fields", "notes", "bindings", "content"]); syncKeys(snap.fields, ["title", "genre", "background", "style", "pace"]);
      for (const k of ["title", "genre", "background", "style", "pace"]) syncText(snap.fields[k]); syncText(snap.content); syncArray(snap.notes);
      const notes = new Map<string, Note>();
      for (const n of snap.notes) { validatePortableNote(n); if (n.projectId !== pid || notes.has(n.id)) fail("同步批次设定引用不正确"); notes.set(n.id, n); }
      bindings(snap.bindings, b.stage, notes, false);
    }
  }
}

function validateSyncOwnership(s: Portable): void {
  const notes = new Map(s.notes.map(n => [n.id, n]));
  const chapters = new Map(s.chapters.map(c => [c.id, c]));
  const snapshots = new Map<string, string>();
  for (const b of s.syncBatches) for (const snap of [b.before, b.after]) for (const n of snap.notes) {
    const owner = snapshots.get(n.id);
    if ((owner && owner !== b.projectId) || (notes.has(n.id) && notes.get(n.id)!.projectId !== b.projectId)) fail("同步历史设定跨作品引用不正确");
    snapshots.set(n.id, b.projectId);
  }
  const note = (id: string, pid: string) => {
    const owner = notes.get(id)?.projectId ?? snapshots.get(id);
    if (owner && owner !== pid) fail("同步设定跨作品引用不正确");
  };
  const sources = (refs: SourceRevision[], pid: string) => {
    for (const ref of refs) {
      if (ref.kind === "project" && ref.id !== pid) fail("同步历史来源跨作品引用不正确");
      if (ref.kind === "note") note(ref.id, pid);
      if (ref.kind === "chapter" && chapters.has(ref.id) && chapters.get(ref.id)!.projectId !== pid) fail("同步历史章节跨作品引用不正确");
    }
  };
  for (const j of s.syncJobs) {
    for (const n of j.baseNoteRevisions) note(n.id, j.projectId);
    for (const b of j.proposal?.blocks ?? []) if (b.noteId) {
      note(b.noteId, j.projectId);
      // A job proposal records its own stage/type at that point in history.
      // validateBundle checks those semantics; later auxiliary edits may move
      // the same identity to another category without rewriting old proposals.
    }
    for (const id of j.proposal?.removeNoteIds ?? []) note(id, j.projectId);
    for (const c of j.conflicts) for (const id of c.noteIds) note(id, j.projectId);
  }
  for (const b of s.syncBatches) for (const snap of [b.before, b.after]) for (const n of snap.notes) {
    note(n.id, b.projectId); sources(n.sources, b.projectId);
  }
}

function validateStoryOwnership(s:Portable):void {
  const chapters=new Map(s.chapters.map(c=>[c.id,c])),notes=new Map(s.notes.map(n=>[n.id,n]));
  const records=new Map(s.storyRecords.map(r=>[r.id,r])),jobs=new Map([...s.storyJobs,...s.writingJobs].map(j=>[j.id,j]));
  for(const r of s.storyRecords){validateStoryRecord(r);
    for(const frame of [r,r.accepted,...r.history,...r.history.map(h=>h.accepted)].filter(Boolean)){
      if(frame!.projectId!==r.projectId||frame!.id!==r.id)fail("故事状态历史归属不正确");
      const n=frame!.entityNoteId?notes.get(frame!.entityNoteId):undefined;
      if(n&&n.projectId!==r.projectId)fail("故事状态人物跨作品引用");
      const origin=frame!.origin.id?jobs.get(frame!.origin.id):undefined;
      if(origin&&origin.projectId!==r.projectId)fail("故事状态任务跨作品引用");
      for(const e of frame!.evidence){const c=chapters.get(e.chapterId);if(c&&(c.projectId!==r.projectId||e.revision>c.revision))fail("故事状态原文来源跨作品或版本不正确");
        if(c&&c.revision===e.revision&&(chapterDigest(c)!==e.contentHash||c.ordinal!==e.ordinal||c.content.slice(e.start,e.end)!==e.quote))fail("故事状态引用与当前原文不一致");
      }
    }
  }
  for(const j of s.storyJobs){validateStoryJob(j);
    for(const e of j.sources){const c=chapters.get(e.chapterId);if(c&&(c.projectId!==j.projectId||e.revision>c.revision))fail("状态提取任务来源跨作品或版本不正确");if(c&&c.revision===e.revision&&(chapterDigest(c)!==e.contentHash||c.content.length!==e.length))fail("状态提取任务来源与原文不一致");}
    for(const id of j.candidateIds){const r=records.get(id);if(r&&r.projectId!==j.projectId)fail("状态提取候选跨作品引用");}
  }
}

function validateSceneOwnership(s:Portable):void{
  const chapters=new Map(s.chapters.map(c=>[c.id,c])),plans=new Map(s.scenePlans.map(p=>[p.id,p]));
  const owners=new Map<string,string>();
  const references=(value:{projectId:string;sources:SourceRevision[]})=>{for(const ref of value.sources){const record=ref.kind==="chapter"?chapters.get(ref.id):ref.kind==="project"?s.projects.find(p=>p.id===ref.id):ref.kind==="note"?s.notes.find(n=>n.id===ref.id):undefined;if(record&&(ref.kind==="project"?record.id!==value.projectId:(record as any).projectId!==value.projectId))fail("场景来源跨作品");}};
  for(const p of s.scenePlans){validateScenePlan(p);const ch=chapters.get(p.chapterId);if(!ch||ch.projectId!==p.projectId)fail("场景章节归属不正确");
    for(const f of [p,...p.history]){references(f);for(const card of f.cards){const owner=owners.get(card.id);if(owner&&owner!==p.id)fail("场景卡身份重复");owners.set(card.id,p.id);const a=card.anchor;if(a&&(a.chapterId!==ch.id||a.revision===ch.revision&&(a.end>ch.content.length||ch.content.slice(a.start,a.end)!==a.quote)))fail("场景绑定原文不正确");}}
  }
  for(const j of s.revisionJobs)if(j.sceneSource){const p=plans.get(j.sceneSource.id);if(!p||p.projectId!==j.projectId||!j.chapterIds.includes(p.chapterId)||![p,...p.history].some(f=>f.cards.some(c=>c.id===j.sceneSource!.cardId)))fail("定向场景改稿引用不正确");}
  for(const j of s.sceneJobs){validateSceneJob(j);const ch=chapters.get(j.chapterId);if(!ch||ch.projectId!==j.projectId)fail("场景任务章节不正确");references(j);const p=j.basePlanId?plans.get(j.basePlanId):undefined;if(j.basePlanId&&(!p||p.projectId!==j.projectId||p.chapterId!==j.chapterId))fail("场景任务原计划引用不正确");}
}
