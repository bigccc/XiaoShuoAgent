import {createHash} from "node:crypto";
import type {AppState,Chapter,Note} from "../shared/types";
import type {StoryRecord,StoryRecordView} from "../shared/story-state";
import type {ContextDocument} from "./context";
export const chapterDigest=(chapter:Chapter)=>chapter.contentHash ?? createHash("sha256").update(chapter.content).digest("hex");
export function storyViews(records:StoryRecord[],chapters:Chapter[],notes:Note[]):StoryRecordView[]{
  const cs=new Map(chapters.map(c=>[c.id,{...c,contentHash:chapterDigest(c)}])),ns=new Map(notes.map(n=>[n.id,n]));
  return records.map(r=>{
    const needsReview=r.evidence.some(e=>{const c=cs.get(e.chapterId);return !c || c.projectId!==r.projectId || c.revision!==e.revision || c.contentHash!==e.contentHash || c.ordinal!==e.ordinal;}) || !!r.entityNoteId && (!ns.has(r.entityNoteId) || ns.get(r.entityNoteId)!.revision!==r.entityRevision || !!ns.get(r.entityNoteId)!.archived);
    const stable=r.status==="confirmed" && r.statement==="fact" && !r.archived && !needsReview && r.evidence.every(e=>{const c=cs.get(e.chapterId);return c?.status==="confirmed"&&!c.needsReview;});
    return {...r,history:[],needsReview,stable,sourceLabels:r.evidence.map(e=>`第${e.ordinal}章 · ${cs.get(e.chapterId)?.title??"已移除"} · 版本${e.revision}`)};
  });
}
const position=(r:StoryRecord)=>r.evidence.at(-1)?.ordinal??0;
const key=(r:StoryRecord)=>[r.kind,r.entityNoteId??r.subject,r.attribute].join("\0");
export function acceptedStory(records:StoryRecord[],before=Infinity):StoryRecord[]{
  return records.flatMap(r=>{
    if(r.archived)return[];
    const accepted=r.accepted??(r.status==="confirmed"?r:undefined);
    if(accepted?.evidence.every(e=>e.ordinal<before))return[{...accepted,history:[]}];
    if(accepted){const previous=[...r.history].reverse().find(h=>h.status==="confirmed"&&h.evidence.every(e=>e.ordinal<before));if(previous)return[{...previous,history:[]}];}
    return[];
  });
}
export function currentStory(views:StoryRecordView[],before=Infinity){
  const eligible=views.filter(r=>!r.archived && r.status==="confirmed" && r.statement==="fact" && r.kind!=="foreshadowing" && r.evidence.every(e=>e.ordinal<before));
  eligible.sort((a,b)=>position(b)-position(a)||(b.evidence.at(-1)?.end??0)-(a.evidence.at(-1)?.end??0)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  const latest=[...new Map(eligible.slice().reverse().map(r=>[key(r),r])).values()];
  return {current:latest.filter(r=>r.stable),blockedCount:latest.filter(r=>!r.stable).length};
}
export interface StoryStamp {beforeOrdinal:number;writingJobId?:string;digest:string}
function selected(state:AppState,beforeOrdinal:number,writingJobId?:string){
  const views=storyViews(state.storyRecords??[],state.chapters,state.notes);
  const accepted=storyViews(acceptedStory(state.storyRecords??[],beforeOrdinal),state.chapters,state.notes);
  const stable=currentStory(accepted,beforeOrdinal).current;
  const foreshadowing=[...new Map(accepted.filter(r=>r.kind==="foreshadowing"&&r.stable&&r.evidence.length&&r.evidence.every(e=>e.ordinal<beforeOrdinal)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).map(r=>[key(r),r])).values()];
  const temporary=writingJobId?views.filter(r=>r.status==="candidate"&&!r.archived&&!r.needsReview&&r.statement==="fact"&&r.origin.kind==="writing"&&r.origin.id===writingJobId&&r.evidence.every(e=>e.ordinal<beforeOrdinal)):[];
  return [...stable,...foreshadowing,...temporary].sort((a,b)=>position(b)-position(a)||a.id.localeCompare(b.id)).slice(0,20);
}
export function storyContext(state:AppState,projectId:string,beforeOrdinal:number,writingJobId?:string):{documents:ContextDocument[];stamp:StoryStamp}{
  const scoped={...state,storyRecords:(state.storyRecords??[]).filter(r=>r.projectId===projectId)};
  const records=selected(scoped,beforeOrdinal,writingJobId);
  const documents=records.flatMap(r=>r.evidence.map(e=>({storyRecordId:r.id,source:{kind:"chapter" as const,id:e.chapterId,revision:e.revision},text:e.quote,label:`第${e.ordinal}章 · ${r.origin.kind==="writing"&&r.status==="candidate"?"本批临时状态，未采纳":"作者确认状态"}：${r.subject}/${r.attribute}=${r.value}${r.foreshadowingStage?`；伏笔${r.foreshadowingStage}`:""}（元信息，非原文）`})));
  const digest=createHash("sha256").update(JSON.stringify(records.map(r=>[r.id,r.revision,r.status,r.evidence]))).digest("hex");
  return {documents,stamp:{beforeOrdinal,...(writingJobId?{writingJobId}:{}),digest}};
}
export function storyStampCurrent(state:AppState,projectId:string,stamp:StoryStamp){return storyContext(state,projectId,stamp.beforeOrdinal,stamp.writingJobId).stamp.digest===stamp.digest;}
