import type { Chapter } from "../shared/types";
import type { RecallReference } from "../shared/recall";

export function ContextReferences({ references, chapters, label = "本次参考的远章原文" }: {
  references?: RecallReference[];
  chapters: Pick<Chapter,"id"|"revision">[];
  label?: string;
}) {
  if (!references?.length) return null;
  return <details className="chat-details" aria-label="远章原文出处">
    <summary>{label}</summary>
    <p className="muted">以下为本次调用实际参考的原文片段，不能代表已读或检查全书。</p>
    {references.map(ref=>{
      const current=chapters.find(c=>c.id===ref.source.id);
      return <article key={ref.source.id}>
        <strong>第{ref.ordinal}章 · {ref.title}</strong>
        <p className="muted">线索：{ref.matchedTerms.join("、")} · 原文版本 {ref.source.revision}</p>
        <blockquote style={{whiteSpace:"pre-wrap"}}>{ref.excerpt}</blockquote>
        {!current && <p className="hint warn">原章节已移除，保留本轮参考记录。</p>}
        {current && current.revision!==ref.source.revision && <p className="hint warn">原文已改变，以上为本轮参考的旧版本；下次创作将重新读取。</p>}
      </article>;
    })}
  </details>;
}
