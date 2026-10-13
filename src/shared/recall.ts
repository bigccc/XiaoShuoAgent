import type { SourceRevision } from "./types";
import { DomainError } from "./validation";

export interface RecallReference {
  source: SourceRevision & { kind: "chapter" };
  ordinal: number;
  title: string;
  start: number;
  end: number;
  excerpt: string;
  matchedTerms: string[];
}
export interface RecallOptions {
  query: string;
  beforeOrdinal: number;
  excludeChapterIds?: string[];
}

export function validateRecallReferences(value: unknown): asserts value is RecallReference[] {
  const fail = (): never => { throw new DomainError("VALIDATION", "远章原文引用格式不正确"); };
  const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  const int = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
  if (!Array.isArray(value) || value.length > 6) fail();
  const ids = new Set<string>();
  for (const r of value as RecallReference[]) {
    if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "end,excerpt,matchedTerms,ordinal,source,start,title" ||
      !r.source || Object.keys(r.source).sort().join(",") !== "id,kind,revision" || r.source.kind !== "chapter" ||
      !text(r.source.id, 200) || !int(r.source.revision, 1) || !int(r.ordinal, 1) ||
      typeof r.title !== "string" || r.title.length > 200 || !int(r.start) || !int(r.end, r.start + 1) ||
      !text(r.excerpt, 480) || r.end - r.start !== r.excerpt.length ||
      !Array.isArray(r.matchedTerms) || r.matchedTerms.length < 1 || r.matchedTerms.length > 24 ||
      r.matchedTerms.some(t => !text(t, 40) || t.length < 2) || ids.has(r.source.id)) fail();
    ids.add(r.source.id);
  }
}
