import type {
  AppState,
  AuthoringDocument,
  AuthoringStage,
  AuthoringState,
  Project,
} from "./types";
import { DomainError, validatePublicJson } from "./validation";

export const planningStages = ["overview", "settings", "outline"] as const;
export const authoringStages = [...planningStages, "writing"] as const;
export const stageNames: Record<AuthoringStage, string> = {
  overview: "概要",
  settings: "设定",
  outline: "大纲",
  writing: "正文",
};
export const stageDescriptions: Record<AuthoringStage, string> = {
  overview: "先看整个故事是否值得写：核心冲突、人物成长、关键转折和结局方向。",
  settings: "围绕故事补齐主要人物、关系、世界规则、背景和基调。",
  outline: "确定全书主线和重要转折，再细化近期 3—5 章。",
  writing: "从第一章试写开始，找到感觉后逐章推进。",
};
export function newDocument(content: string): AuthoringDocument {
  return {
    content,
    revision: 1,
    approved: false,
    needsReview: false,
    history: [],
  };
}
export function readAuthoring(
  state: AppState,
  project: Project,
): AuthoringState {
  if (project.authoring)
    return {
      ...structuredClone(project.authoring),
      ...(project.authoring.activeStage === "writing"
        ? { writingStarted: true }
        : {}),
    };
  const notes = state.notes.filter((n) => n.projectId === project.id);
  const documents: AuthoringState["documents"] = {};
  if (project.background.trim())
    documents.overview =
      project.background.length <= 30000
        ? newDocument(project.background)
        : {
            ...newDocument(
              "原作品背景超过阶段成果长度，全文仍保留在「创意与风格」。请让 AI 基于原文整理故事概要。",
            ),
            needsReview: true,
          };
  for (const stage of ["settings", "outline"] as const) {
    const selected = notes.filter((n) =>
      (stage === "settings"
        ? ["character", "world", "location"]
        : ["outline", "chapterOutline", "storyline"]
      ).includes(n.type),
    );
    if (selected.length) {
      const content = selected
        .map((n) => `## ${n.title}\n${n.body}`)
        .join("\n\n");
      const oversized = content.length > 30000;
      documents[stage] = {
        ...newDocument(
          oversized
            ? `已有 ${selected.length} 份${stageNames[stage]}资料，全文保留在创作资料中。以下仅为索引，请让 AI 结合原文整理阶段成果：\n\n${selected
                .map((n) => n.title)
                .join("\n")
                .slice(0, 20000)}`
            : content,
        ),
        needsReview: oversized || selected.some((n) => n.needsReview),
      };
    }
  }
  return {
    ...(state.chapters.some((c) => c.projectId === project.id)
      ? { writingStarted: true }
      : {}),
    activeStage: state.chapters.some((c) => c.projectId === project.id)
      ? "writing"
      : documents.outline
        ? "outline"
        : documents.settings
          ? "settings"
          : "overview",
    documents,
  };
}
export function validateAuthoring(
  value: unknown,
): asserts value is AuthoringState {
  const fail = (): never => {
    throw new DomainError("VALIDATION", "创作阶段或成果数据格式不正确");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, any>;
  if (
    Object.keys(v).some(
      (k) =>
        !["activeStage", "documents", "reviewGroup", "writingStarted"].includes(
          k,
        ),
    ) ||
    !authoringStages.includes(v.activeStage) ||
    !v.documents ||
    typeof v.documents !== "object" ||
    Array.isArray(v.documents)
  )
    fail();
  if (v.writingStarted !== undefined && typeof v.writingStarted !== "boolean")
    fail();
  for (const [stage, raw] of Object.entries(v.documents)) {
    if (
      !planningStages.includes(stage as any) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    )
      fail();
    const d = raw as Record<string, any>;
    if (
      Object.keys(d).some(
        (k) =>
          ![
            "content",
            "revision",
            "approved",
            "needsReview",
            "history",
            "sync",
          ].includes(k),
      ) ||
      typeof d.content !== "string" ||
      d.content.length > 30000 ||
      !Number.isSafeInteger(d.revision) ||
      d.revision < 1 ||
      typeof d.approved !== "boolean" ||
      typeof d.needsReview !== "boolean" ||
      (d.approved && (d.needsReview || !d.content.trim())) ||
      !Array.isArray(d.history) ||
      d.history.length > 100000
    )
      fail();
    for (const h of d.history)
      if (
        !h ||
        typeof h.content !== "string" ||
        h.content.length > 30000 ||
        !Number.isSafeInteger(h.revision) ||
        h.revision < 1 ||
        !Number.isFinite(Date.parse(h.createdAt))
      )
        fail();
    if (
      d.history.some(
        (h: any) =>
          h.batchId !== undefined &&
          (typeof h.batchId !== "string" || !h.batchId),
      )
    )
      fail();
    if (d.sync !== undefined) {
      const s = d.sync;
      if (
        !s ||
        typeof s !== "object" ||
        Array.isArray(s) ||
        Object.keys(s).some(
          (k) =>
            ![
              "status",
              "bindings",
              "lastSyncedContent",
              "lastSyncedRevision",
              "jobId",
              "batchId",
              "error",
            ].includes(k),
        ) ||
        !["synced", "pending", "running", "failed", "conflict"].includes(
          s.status,
        ) ||
        !Array.isArray(s.bindings) ||
        s.bindings.length > 1000 ||
        typeof s.lastSyncedContent !== "string" ||
        s.lastSyncedContent.length > 30000 ||
        !Number.isSafeInteger(s.lastSyncedRevision) ||
        s.lastSyncedRevision < 0 ||
        s.lastSyncedRevision > d.revision
      )
        fail();
      for (const key of ["jobId", "batchId", "error"])
        if (s[key] !== undefined && (typeof s[key] !== "string" || !s[key]))
          fail();
      const ids = new Set<string>();
      for (const b of s.bindings) {
        if (
          !b ||
          typeof b.id !== "string" ||
          !b.id ||
          ids.has(b.id) ||
          Object.keys(b).some(
            (k) => !["id", "kind", "field", "noteId", "heading"].includes(k),
          ) ||
          (b.heading !== undefined && typeof b.heading !== "boolean")
        )
          fail();
        ids.add(b.id);
        if (
          b.kind === "field"
            ? typeof b.field !== "string" ||
              !["title", "genre", "background", "style", "pace"].includes(
                b.field,
              ) ||
              b.noteId !== undefined
            : b.kind !== "note" ||
              typeof b.noteId !== "string" ||
              !b.noteId ||
              b.field !== undefined
        )
          fail();
      }
      if (
        s.status === "synced" &&
        (s.lastSyncedRevision !== d.revision ||
          s.lastSyncedContent !== d.content)
      )
        fail();
      if (d.approved && s.status !== "synced") fail();
    }
  }
  if (
    v.reviewGroup !== undefined &&
    (!Array.isArray(v.reviewGroup) ||
      v.reviewGroup.length > 3 ||
      new Set(v.reviewGroup).size !== v.reviewGroup.length ||
      v.reviewGroup.some(
        (s: string) =>
          !planningStages.includes(s as any) ||
          !v.documents[s] ||
          v.documents[s].needsReview,
      ))
  )
    fail();
  validatePublicJson(value);
}
