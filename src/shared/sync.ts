import type {
  AppState,
  PlanningStage,
  StageBinding,
  StageBundle,
  StageBlockInput,
  SyncField,
  SyncNoteType,
} from "./types";
import { DomainError, validatePublicJson } from "./validation";
export const syncFields: SyncField[] = [
  "title",
  "genre",
  "background",
  "style",
  "pace",
];
export const fieldStage: Record<SyncField, PlanningStage> = {
  title: "overview",
  genre: "overview",
  background: "overview",
  style: "settings",
  pace: "settings",
};
export const fieldLabels: Record<SyncField, string> = {
  title: "作品名称",
  genre: "题材",
  background: "简介与背景",
  style: "文风",
  pace: "节奏",
};
export const stageNoteTypes: Record<PlanningStage, SyncNoteType[]> = {
  overview: ["supplement"],
  settings: ["character", "world", "location", "supplement"],
  outline: ["storyline", "outline", "chapterOutline", "supplement"],
};
function fail(message = "同步结果格式不完整，请重试；原文仍保留"): never {
  throw new DomainError("VALIDATION", message);
}
export function validateBundle(value: unknown): asserts value is StageBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as any;
  if (
    Object.keys(v).some(
      (k) => !["stage", "blocks", "removeNoteIds", "removeFields"].includes(k),
    ) ||
    !["overview", "settings", "outline"].includes(v.stage) ||
    !Array.isArray(v.blocks) ||
    v.blocks.length > 1000
  )
    fail();
  const ids = new Set<string>(),
    fields = new Set<string>(),
    notes = new Set<string>();
  for (const b of v.blocks) {
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      Object.keys(b).some(
        (k) =>
          ![
            "id",
            "kind",
            "field",
            "noteId",
            "noteType",
            "title",
            "text",
            "startLine",
            "endLine",
            "heading",
          ].includes(k),
      )
    )
      fail();
    for (const k of ["id", "noteId"])
      if (
        b[k] !== undefined &&
        (typeof b[k] !== "string" || !b[k] || b[k].length > 200)
      )
        fail();
    if (b.id) {
      if (ids.has(b.id)) fail("同步结果包含重复内容块");
      ids.add(b.id);
    }
    if (b.heading !== undefined && typeof b.heading !== "boolean") fail();
    if (
      b.text !== undefined &&
      (typeof b.text !== "string" || b.text.length > 30000)
    )
      fail();
    if (
      (b.startLine !== undefined || b.endLine !== undefined) &&
      (!Number.isSafeInteger(b.startLine) ||
        !Number.isSafeInteger(b.endLine) ||
        b.startLine < 1 ||
        b.endLine < b.startLine)
    )
      fail();
    if (b.text === undefined && b.startLine === undefined) fail();
    if (b.kind === "field") {
      if (
        !syncFields.includes(b.field) ||
        fieldStage[b.field as SyncField] !== v.stage ||
        b.noteId !== undefined ||
        b.noteType !== undefined ||
        fields.has(b.field)
      )
        fail("作品字段归类错误或重复");
      fields.add(b.field);
    } else if (b.kind === "note") {
      if (
        !stageNoteTypes[v.stage as PlanningStage].includes(b.noteType) ||
        typeof b.title !== "string" ||
        !b.title.trim() ||
        b.title.length > 200 ||
        b.field !== undefined ||
        (b.noteId && notes.has(b.noteId))
      )
        fail("设定记录归类错误或重复");
      if (b.noteId) notes.add(b.noteId);
    } else fail();
  }
  for (const key of ["removeNoteIds", "removeFields"])
    if (
      v[key] !== undefined &&
      (!Array.isArray(v[key]) ||
        v[key].length > 1000 ||
        new Set(v[key]).size !== v[key].length ||
        v[key].some((x: unknown) => typeof x !== "string" || !x))
    )
      fail();
  if (v.removeNoteIds?.some((id: string) => notes.has(id)))
    fail("同一记录不能同时修改和移除");
  if (
    v.removeFields?.some(
      (f: SyncField) =>
        !syncFields.includes(f) || fieldStage[f] !== v.stage || fields.has(f),
    )
  )
    fail("作品字段移除范围不正确");
  validatePublicJson(value);
}
export function materializeBundle(
  bundle: StageBundle,
  source?: string,
): StageBundle {
  validateBundle(bundle);
  if (source === undefined) {
    if (
      bundle.blocks.some(
        (b) => b.text === undefined || b.startLine !== undefined,
      )
    )
      fail();
    return structuredClone(bundle);
  }
  const lines = source.replace(/\r\n?/g, "\n").split("\n"),
    covered = new Set<number>();
  const blocks: StageBlockInput[] = bundle.blocks.map((b) => {
    if (
      b.startLine === undefined ||
      b.endLine === undefined ||
      b.endLine > lines.length
    )
      fail("整理结果没有完整来源行范围");
    for (let i = b.startLine; i <= b.endLine; i++) {
      if (covered.has(i) && lines[i - 1].trim()) fail("来源行重复归类");
      covered.add(i);
    }
    let text = lines.slice(b.startLine - 1, b.endLine).join("\n"),
      heading = false;
    if (b.text !== undefined && b.text !== text)
      fail("整理不能改写或遗漏源文事实");
    const label = b.kind === "field" ? fieldLabels[b.field!] : b.title!;
    const first = text.split("\n")[0];
    if (first.replace(/^\s*#+\s*/, "").trim() === label) {
      text = text.slice(first.length).replace(/^\n/, "");
      heading = true;
    }
    const { startLine, endLine, ...rest } = b;
    return { ...rest, text, heading };
  });
  const missing = lines.flatMap((line, index) =>
    line.trim() && !covered.has(index + 1) ? [index + 1] : [],
  );
  if (missing.length)
    fail(
      `整理遗漏了源文内容：行号 ${missing.slice(0, 40).join(",")}。请将未分类内容保留为补充说明`,
    );
  return { ...bundle, blocks };
}
export function renderStage(
  bindings: StageBinding[],
  state: AppState,
  projectId: string,
): string {
  const p = state.projects.find((p) => p.id === projectId);
  if (!p) throw new DomainError("NOT_FOUND", "作品不存在");
  return bindings
    .flatMap((b) => {
      if (b.kind === "field") {
        const value = p[b.field!];
        return [
          b.heading === false || b.field === "background"
            ? value
            : `## ${fieldLabels[b.field!]}\n${value}`,
        ];
      }
      const n = state.notes.find(
        (n) => n.id === b.noteId && n.projectId === projectId && !n.archived,
      );
      return n
        ? [b.heading === false ? n.body : `## ${n.title}\n${n.body}`]
        : [];
    })
    .join("\n\n");
}
