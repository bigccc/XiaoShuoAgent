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
import type { AppState, SourceRevision } from "../shared/types";
import {
  DomainError,
  validatePublicJson,
  validateSources,
  validateTask,
  validateIssue,
} from "../shared/validation";
import { Store, type Collection } from "./store";
const MAX_SOURCE = 2_000_000,
  MAX_PACKAGE = 100_000_000;
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
] as const;
type Portable = Pick<AppState, (typeof tables)[number]>;
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
        version: 1,
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
      pack.version !== 1 ||
      !pack.payload ||
      pack.sha256 !== digest(pack.payload)
    )
      fail("作品包版本或完整性校验失败");
    const s = pack.payload as Portable;
    if (pack.format === "xiaoshuo-recovery") validateRecovery(s);
    else validatePortable(s);
    return this.importPayload(s);
  }
  private importPayload(s: Portable): string {
    const ids = new Map<string, string>();
    for (const table of tables)
      for (const r of s[table]) ids.set(r.id, randomUUID());
    const remap = (id: string) => {
      if (!ids.has(id)) ids.set(id, randomUUID());
      return ids.get(id)!;
    };
    const sources = (items: SourceRevision[]) =>
      items.map((ref) => ({ ...ref, id: remap(ref.id) }));
    const newId = s.projects.length
      ? remap(s.projects[0].id)
      : s.materials.length
        ? remap(s.materials[0].id)
        : "";
    if (!newId) fail("恢复包没有可导入的内容");
    const nested = (x: any): any => {
      if (Array.isArray(x)) return x.map(nested);
      if (x && typeof x === "object")
        return Object.fromEntries(
          Object.entries(x).map(([k, v]) => [
            k,
            typeof v === "string" &&
            (k === "id" || k.endsWith("Id")) &&
            ids.has(v)
              ? remap(v)
              : nested(v),
          ]),
        );
      return typeof x === "string" && ids.has(x) ? remap(x) : x;
    };
    this.store.transaction(() => {
      for (const p of s.projects)
        this.store.put("projects", {
          ...p,
          id: remap(p.id),
          title: p.title + "（副本）",
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
    });
    return newId;
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
  const chapters = new Set(s.chapters.map((c: any) => c.id));
  const ordinals = new Set();
  const versions = new Set(s.versions.map((v: any) => v.id));
  for (const n of s.notes) {
    if (
      ![
        "character",
        "world",
        "location",
        "storyline",
        "outline",
        "chapterOutline",
        "summary",
        "timeline",
        "knowledge",
        "foreshadowing",
      ].includes(n.type)
    )
      fail("设定类型不正确");
    str(n.title);
    str(n.body);
    validateSources(n.sources);
    if (typeof n.needsReview !== "boolean") fail("设定状态不正确");
  }
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
  for (const t of s.tasks) validateTask(t);
  for (const i of s.issues) {
    validateIssue(i);
    if (i.chapterId && !chapters.has(i.chapterId))
      fail("作品包检查问题引用不正确");
  }
}

function validateRecovery(s: any): void {
  validatePublicJson(s);
  if (
    !s ||
    s.schemaVersion !== 1 ||
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
  for (const task of s.tasks) validateTask(task);
  for (const project of s.projects) {
    const pid = project.id;
    validatePortable({
      projects: [project],
      notes: s.notes.filter((r: any) => r.projectId === pid),
      chapters: s.chapters.filter((r: any) => r.projectId === pid),
      versions: s.versions.filter((r: any) => r.projectId === pid),
      tasks: s.tasks.filter((r: any) => r.projectId === pid),
      issues: s.issues.filter((r: any) => r.projectId === pid),
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
