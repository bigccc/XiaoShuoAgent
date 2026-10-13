import type { AppState } from "../shared/types";
import type { RecallOptions, RecallReference } from "../shared/recall";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stopWords = new Set("继续 接着 开始 正文 故事 小说 章节 第一 第二 第三 第四 第五 前五 一章 五章 写完 写作 创作 改写 修改 帮我 推荐 按照 生成 当时 什么 现在 不要 改变 这里 那里 这个 那个 他们 我们 一个 本章 计划 检查 问题 如何 为什么 是否 可以 没有 已经 需要 然后 如果 但是 因为 所以 进行 完成 身份 寻找".split(" "));

function termsFor(state: AppState, projectId: string, query: string, before: number): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (s: string, weight: number) => {
    const t = s.trim();
    if (t.length >= 2 && t.length <= 40 && !stopWords.has(t) && !/^\d+$/.test(t)) terms.set(t, Math.max(weight, terms.get(t) ?? 0));
  };
  const relevant = state.notes.filter(n => n.projectId === projectId && !n.archived && !n.needsReview && ["character", "location"].includes(n.type) && n.sources.every(ref => {
    const record = (ref.kind === "chapter" ? state.chapters : ref.kind === "note" ? state.notes : state.projects).find(r => r.id === ref.id);
    return record?.revision === ref.revision && (ref.kind !== "chapter" || "ordinal" in record && record.ordinal < before);
  }));
  for (const n of relevant) {
    const aliases = [...n.body.matchAll(/(?:^|\n)\s*(?:别名|别称|昵称)\s*[:：]\s*([^\n。]+)/g)].flatMap(m => m[1].split(/[、,，;；\/|]/)).map(t => t.trim());
    if ([n.title, ...aliases].some(t => t.length >= 2 && query.includes(t))) for (const t of [n.title, ...aliases]) add(t, 3);
  }
  // Explicit space-delimited names/objects preserve compounds ICU might split.
  for (const token of query.split(/\s+/)) if (/^[\p{L}\p{N}]{2,12}$/u.test(token)) add(token, 2);
  for (const part of segmenter.segment(query)) if (part.isWordLike) add(part.segment, 1);
  return new Map([...terms].slice(0, 24));
}

/** On-demand from current source versions; no derived memory can outlive its source. */
export function recallPassages(state: AppState, projectId: string, options: RecallOptions): RecallReference[] {
  if (!Number.isSafeInteger(options.beforeOrdinal) || options.beforeOrdinal < 1 || !options.query.trim()) return [];
  const terms = termsFor(state, projectId, options.query.slice(0, 20000), options.beforeOrdinal);
  if (!terms.size) return [];
  const excluded = new Set(options.excludeChapterIds ?? []);
  const hits: { score: number; reference: RecallReference }[] = [];
  for (const c of state.chapters) {
    if (c.projectId !== projectId || c.ordinal >= options.beforeOrdinal || c.status !== "confirmed" || c.needsReview || excluded.has(c.id)) continue;
    // Bound work for repeated terms, while retaining both early and late occurrences.
    const anchors = new Set<number>();
    for (const term of terms.keys()) {
      let at = c.content.indexOf(term);
      for (let i=0; at>=0 && i<16; i++) {
        anchors.add(at);
        at=c.content.indexOf(term,at+term.length);
      }
      const last=c.content.lastIndexOf(term);
      if(last>=0)anchors.add(last);
    }
    if (!anchors.size) continue;
    let best: { score: number; start: number; end: number; matchedTerms: string[] } | undefined;
    for (const at of [...anchors].sort((a,b)=>a-b)) {
      const start = Math.max(0, at - 120), end = Math.min(c.content.length, start + 480);
      const excerpt=c.content.slice(start,end);
      const local=[...terms].filter(([term])=>excerpt.includes(term));
      const score=local.reduce((sum,[,weight])=>sum+weight,0);
      if (!best || score > best.score) best = { score, start, end, matchedTerms: local.map(([term]) => term) };
    }
    if (!best) continue;
    hits.push({ score: best.score, reference: { source: { kind: "chapter", id: c.id, revision: c.revision }, ordinal: c.ordinal, title: c.title.slice(0, 200), start: best.start, end: best.end, excerpt: c.content.slice(best.start, best.end), matchedTerms: best.matchedTerms } });
  }
  return hits.sort((a, b) => b.score - a.score || b.reference.ordinal - a.reference.ordinal || a.reference.source.id.localeCompare(b.reference.source.id)).slice(0, 6).map(h => h.reference);
}
