import { createHash } from "node:crypto";
import type { BuiltContext } from "./context";
import type { WritingIssue } from "../shared/writing";

/** A local reading guide. Excerpts remain source material, never new asserted facts. */
export function chapterBrief(context: BuiltContext, ordinal: number, currentId?: string) {
  let remaining=4000;
  const candidates=context.documents.filter(d=>d.text&&d.source.id!==currentId);
  // Keep this guide small; full source text is already present in context.
  const references=candidates.slice(0,20).map(d=>{
    const length=Math.min(600,remaining);remaining-=length;
    return {source:d.source,label:d.label.slice(0,100),excerpt:length?(d.source.kind==="chapter"?d.text.slice(-length):d.text.slice(0,length)):"",partial:d.text.length>length};
  });
  return { ordinal, references, incomplete: context.disclosures,
    rules: "动笔前核对人物位置、持有物、知情范围和时间承接。参考摘录不是全部设定，完整依据见context；计划、猜测、回忆不得当作当前事实。普通细节自主补全，明确设定冲突合并提出。" };
}

/** Source content, not metadata-only revision bumps, determines whether a focused verification is safe. */
export function repairReferenceDigest(context: BuiltContext, chapterId: string) {
  return createHash("sha256").update(JSON.stringify(context.documents.filter(d => d.source.id !== chapterId)
    .map(d => [d.source.kind, d.source.id, d.text]))).digest("hex");
}

export function repairPassages(before: string, content: string, edits: { start: number; end: number; replacement: string }[], issues: WritingIssue[], chapterId: string) {
  const ranges: {start:number;end:number}[] = [];
  let offset = 0;
  for (const edit of edits) {
    const start = edit.start + offset;
    ranges.push({start:Math.max(0,start-240),end:Math.min(content.length,start+edit.replacement.length+240)});
    offset += edit.replacement.length - (edit.end-edit.start);
  }
  const position = (old: number, end: boolean) => {
    let shift=0;
    for(const edit of edits){
      if(old<=edit.start)break;
      if(old<edit.end)return edit.start+shift+(end?edit.replacement.length:0);
      shift+=edit.replacement.length-(edit.end-edit.start);
    }
    return old+shift;
  };
  for (const evidence of issues.flatMap(i=>i.evidence).filter(e=>e.source.id===chapterId)) {
    const start=before.indexOf(evidence.quote);
    // Ambiguous evidence locations require a full check, rather than choosing
    // an arbitrary occurrence and silently losing another conflicting clause.
    if(start<0 || before.indexOf(evidence.quote,start+1)>=0)return [content];
    ranges.push({start:Math.max(0,position(start,false)-80),end:Math.min(content.length,position(start+evidence.quote.length,true)+80)});
  }
  ranges.sort((a,b)=>a.start-b.start);
  const merged:typeof ranges=[];
  for(const range of ranges){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
  return merged.map(r=>content.slice(r.start,r.end));
}
