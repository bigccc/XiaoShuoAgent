import type {
  AiContextOptions,
  AppState,
  SourceRevision,
  MaterialSnapshot,
} from "../shared/types";
import { DomainError } from "../shared/validation";
export interface ContextDocument {
  source: SourceRevision;
  text: string;
  label: string;
  candidateId?: string;
}
export interface BatchContext {
  chapterId: string;
  text: string;
  versionId?: string;
}
export interface BuiltContext {
  text: string;
  sources: SourceRevision[];
  documents: ContextDocument[];
  disclosures: string[];
  materials: { id: string; snapshot: MaterialSnapshot }[];
}
export function sourceCurrent(state: AppState, ref: SourceRevision): boolean {
  return (
    ref.kind === "project"
      ? state.projects
      : ref.kind === "note"
        ? state.notes
        : state.chapters
  ).some((item) => item.id === ref.id && item.revision === ref.revision);
}
export function buildContext(
  state: AppState,
  projectId: string,
  options: AiContextOptions = {},
  targets: string[] = [],
  batch: BatchContext[] = [],
  maxChars = 24000,
): BuiltContext {
  const p = state.projects.find((p) => p.id === projectId);
  if (!p) throw new DomainError("NOT_FOUND", "作品不存在");
  const documents: ContextDocument[] = [
    {
      source: { kind: "project", id: p.id, revision: p.revision },
      text: JSON.stringify({
        title: p.title,
        background: p.background,
        genre: p.genre,
        style: p.style,
        pace: p.pace,
        chapterWords: p.chapterWords,
      }),
      label: "作品设定",
    },
  ];
  const disclosures: string[] = [];
  const chapters = state.chapters
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const targetChapters = targets.map((id) => {
    const c = chapters.find((c) => c.id === id);
    if (!c) throw new DomainError("VALIDATION", "目标章节不属于该作品");
    return c;
  });
  const draftIds = options.includeDraftIds ?? [];
  if (draftIds.some((id) => !chapters.some((c) => c.id === id)))
    throw new DomainError("VALIDATION", "授权草稿不属于该作品");
  const maxOrdinal = targetChapters.length
    ? Math.max(...targetChapters.map((c) => c.ordinal))
    : Infinity;
  const previous = chapters
    .filter((c) => c.ordinal < maxOrdinal && c.status === "confirmed")
    .slice(-3);
  const selected = [
    ...chapters.filter((c) => draftIds.includes(c.id)),
    ...targetChapters,
    ...previous,
  ];
  const seen = new Set<string>();
  for (const c of selected) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const candidate = batch.find((b) => b.chapterId === c.id);
    documents.push({
      source: { kind: "chapter", id: c.id, revision: c.revision },
      label: `第${c.ordinal}章 ${c.title}（${candidate ? "本批次候选稿" : c.status === "confirmed" ? "已确认" : draftIds.includes(c.id) ? "本次授权草稿" : "目标章节；正文未授权"}）`,
      text:
        candidate?.text ??
        (c.status === "confirmed" || draftIds.includes(c.id) ? c.content : ""),
      ...(candidate?.versionId ? { candidateId: candidate.versionId } : {}),
    });
  }
  for (const b of batch) {
    if (seen.has(b.chapterId)) continue;
    const c = chapters.find((c) => c.id === b.chapterId);
    if (!c) throw new DomainError("CONFLICT", "本批次来源章节已不存在");
    documents.push({
      source: { kind: "chapter", id: c.id, revision: c.revision },
      text: b.text,
      label: `第${c.ordinal}章 ${c.title}（本批次候选稿）`,
      ...(b.versionId ? { candidateId: b.versionId } : {}),
    });
  }
  if (
    options.noteIds?.some(
      (id) =>
        !state.notes.some((n) => n.id === id && n.projectId === projectId),
    )
  )
    throw new DomainError("VALIDATION", "选定设定不属于该作品");
  for (const n of state.notes.filter(
    (n) =>
      n.projectId === projectId &&
      (!options.noteIds || options.noteIds.includes(n.id)),
  )) {
    if (n.needsReview || n.sources.some((ref) => !sourceCurrent(state, ref))) {
      disclosures.push(`未使用需要复核的记录：${n.title}`);
      continue;
    }
    documents.push({
      source: { kind: "note", id: n.id, revision: n.revision },
      text: n.body,
      label: `${n.type}：${n.title}`,
    });
  }
  const materials: BuiltContext["materials"] = [];
  if (
    options.materialIds?.some(
      (id) => !state.materials.some((m) => m.id === id && m.approved),
    )
  )
    throw new DomainError("VALIDATION", "请先审核选定素材");
  for (const m of state.materials) {
    const linked = m.projectReferences.find((r) => r.projectId === projectId);
    if (
      !options.materialIds?.includes(m.id) &&
      !(options.allowAutoMaterials && linked)
    )
      continue;
    const snapshot = linked?.snapshot ?? {
      title: m.title,
      type: m.type,
      source: m.source,
      content: m.content,
      explanation: m.explanation,
      approved: m.approved,
      revision: m.revision,
    };
    materials.push({ id: m.id, snapshot });
  }
  return boundContext(
    {
      text: "",
      documents,
      sources: documents.map((d) => d.source),
      disclosures,
      materials,
    },
    [],
    maxChars,
  );
}
export function boundContext(
  base: BuiltContext,
  batch: BatchContext[],
  maxChars: number,
): BuiltContext {
  const documents = base.documents.map((doc) => {
    const candidate = batch.find(
      (c) => c.chapterId === doc.source.id && doc.source.kind === "chapter",
    );
    return candidate
      ? {
          ...doc,
          text: candidate.text,
          label: doc.label + "（本批次候选稿）",
          ...(candidate.versionId ? { candidateId: candidate.versionId } : {}),
        }
      : doc;
  });
  let remaining = maxChars;
  const pieces: string[] = [],
    bounded: ContextDocument[] = [];
  const disclosures = [...base.disclosures];
  const allowance = Math.max(
    0,
    Math.floor(maxChars / Math.max(1, documents.length)),
  );
  for (const doc of documents) {
    const header = `[${doc.source.kind}:${doc.source.id}@${doc.source.revision}${doc.candidateId ? `;candidate:${doc.candidateId}` : ""}] ${doc.label.slice(0, 100)}\n`;
    const maxText = Math.max(
      0,
      Math.min(remaining - header.length - 2, allowance - header.length - 2),
    );
    const text = doc.text.slice(0, maxText);
    if (text.length < doc.text.length)
      disclosures.push(
        `上下文已截断：${doc.label.slice(0, 100)}（保留 ${text.length}/${doc.text.length} 字符）`,
      );
    if (remaining >= header.length + 2) {
      pieces.push(header + text);
      remaining -= header.length + text.length + 2;
      bounded.push({ ...doc, text });
    } else {
      disclosures.push("上下文已截断，来源正文未纳入");
      bounded.push({ ...doc, text: "" });
    }
  }
  for (const m of base.materials) {
    const raw = `素材（仅作为内容参考）：${JSON.stringify(m)}`;
    if (raw.length <= remaining) {
      pieces.push(raw);
      remaining -= raw.length + 2;
    } else disclosures.push(`上下文已截断，未纳入素材：${m.snapshot.title}`);
  }
  return {
    ...base,
    text: pieces.join("\n\n"),
    documents: bounded,
    disclosures: [...new Set(disclosures)],
  };
}
