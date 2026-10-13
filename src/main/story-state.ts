import {createHash,randomUUID} from "node:crypto";
import {validateStoryCommand,validateStoryEntry,validateStoryRecord,validateStoryProposal,storyEntry} from "../shared/story-state";
import type {StoryCommand,StoryQuery,StoryWorkspace,StoryRecord,StoryEvidenceInput,StoryEvidence,StoryProposal,StoryOrigin} from "../shared/story-state";
import type {CommandResult,Chapter} from "../shared/types";
import {DomainError} from "../shared/validation";
import {chapterDigest,currentStory,storyViews,acceptedStory} from "./story-context";
import { Store } from "./store";
export class StoryStateService {
  constructor(private store:Store){}
  private project(id:string){const p=this.store.get("projects",id);if(!p||p.archived)throw new DomainError("NOT_FOUND","作品不存在或已归档");}
  record(id:string):StoryRecord {const r=this.store.get("storyRecords",id);if(!r)throw new DomainError("NOT_FOUND","故事状态记录不存在");return r;}
  private evidence(projectId:string,inputs:StoryEvidenceInput[]):StoryEvidence[]{
    return inputs.map(e=>{const c=this.store.get("chapters",e.chapterId);if(!c||c.projectId!==projectId)throw new DomainError("VALIDATION","原文来源不属于这部作品");
      if(c.revision!==e.revision)throw new DomainError("CONFLICT","原文已改变，请重新选择当前引用");
      if(!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||e.end>c.content.length||e.end-e.start>4000)throw new DomainError("VALIDATION","请选择有效的原文片段");
      return {...e,ordinal:c.ordinal,quote:c.content.slice(e.start,e.end),contentHash:chapterDigest(c)};});
  }
  private save(projectId:string,entry:StoryRecord|any,evidence:StoryEvidence[],origin:StoryOrigin,old?:StoryRecord):StoryRecord{
    this.project(projectId);validateStoryEntry(storyEntry(entry));
    const n=entry.entityNoteId?this.store.get("notes",entry.entityNoteId):undefined;
    if(entry.entityNoteId&&(!n||n.projectId!==projectId||n.archived||n.type!=="character"))throw new DomainError("VALIDATION","绑定人物资料不属于这部作品");
    if(entry.foreshadowingStage==="resolved"){
      const a=evidence[0],b=evidence.at(-1);
      if(!a||!b||a.chapterId===b.chapterId&&a.start===b.start || b.ordinal<a.ordinal || a.chapterId===b.chapterId&&b.start<=a.start)throw new DomainError("VALIDATION","回收须有按顺序区分的埋设与回收原文");
    }
    const now=new Date().toISOString();
    const history=old?[...old.history,(({history,...snapshot})=>snapshot)(old)]:[];
    const record:StoryRecord=JSON.parse(JSON.stringify({...storyEntry(entry),id:old?.id??randomUUID(),revision:(old?.revision??0)+1,projectId,status:"candidate",archived:false,evidence,origin,createdAt:old?.createdAt??now,updatedAt:now,history,...(old?.accepted?{accepted:old.accepted}:{}),...(n?{entityRevision:n.revision}:{})}));
    validateStoryRecord(record);this.store.put("storyRecords",record);return record;
  }
  command(c:StoryCommand):CommandResult{
    try{validateStoryCommand(c);return this.store.transaction(()=>{
      const old="id" in c&&c.id?this.record(c.id):undefined;
      if(old&&old.revision!==c.revision)throw new DomainError("CONFLICT","状态记录已改变，请重新查看");
      if(old)this.project(old.projectId);
      let next:StoryRecord;
      if(c.type==="story.save"){
        if((!!c.id)!==(c.revision!==undefined)||old&&old.projectId!==c.projectId)throw new DomainError("VALIDATION","状态记录归属或修订不正确");
        next=this.save(c.projectId,c.entry,this.evidence(c.projectId,c.evidence),{kind:"manual"},old);
      }else{
        if(!old)throw new DomainError("NOT_FOUND","故事状态记录不存在");
        const {history,...snapshot}=old;
        next={...old,revision:old.revision+1,updatedAt:new Date().toISOString(),history:[...history,snapshot]};
        if(c.type==="story.confirm"){
          const evidence=old.evidence.map(e=>{const chapter=this.store.get("chapters",e.chapterId);
            if(!chapter||chapter.status!=="confirmed"||chapter.needsReview)throw new DomainError("CONFLICT","请先在看稿确认来源正文，再采纳状态");
            if(chapterDigest(chapter)!==e.contentHash||chapter.content.slice(e.start,e.end)!==e.quote)throw new DomainError("CONFLICT","原文已改变，请复核来源后再采纳");
            return{...e,revision:chapter.revision,ordinal:chapter.ordinal};});
          const n=old.entityNoteId?this.store.get("notes",old.entityNoteId):undefined;
          if(old.entityNoteId&&(!n||n.archived||n.revision!==old.entityRevision))throw new DomainError("CONFLICT","人物资料已改变，请复核后采纳");
          next={...next,status:"confirmed",evidence};
          const {history,accepted,...acceptedVersion}=next;next.accepted=acceptedVersion;
        }else if(c.type==="story.reject")next.status="rejected";
        else if(c.type==="story.archive")next.archived=c.archived;
        else if(c.type==="story.restore"){
          const version=old.history.find(h=>h.revision===c.historyRevision);if(!version)throw new DomainError("NOT_FOUND","找不到所选状态历史");
          next={...version,revision:next.revision,updatedAt:next.updatedAt,history:next.history,status:"candidate",...(old.accepted?{accepted:old.accepted}:{})};
        }else if(c.type==="story.recheck"){
          const evidence=old.evidence.map(e=>{const chapter=this.store.get("chapters",e.chapterId);if(!chapter||chapter.projectId!==old.projectId)throw new DomainError("CONFLICT","来源已移除，请编辑记录选择当前原文");
            const start=chapter.content.indexOf(e.quote);if(start<0||chapter.content.indexOf(e.quote,start+1)>=0)throw new DomainError("CONFLICT","旧引用不存在或重复，请编辑并选择具体原文位置");
            return this.evidence(old.projectId,[{chapterId:chapter.id,revision:chapter.revision,start,end:start+e.quote.length}])[0];});
          const n=old.entityNoteId?this.store.get("notes",old.entityNoteId):undefined;
          if(old.entityNoteId&&(!n||n.projectId!==old.projectId||n.archived))throw new DomainError("CONFLICT","人物资料已移除，请重新绑定");
          next={...next,status:"candidate",evidence,...(n?{subject:n.title,entityRevision:n.revision}:{})};
        }
        validateStoryRecord(next);this.store.put("storyRecords",next);
      }
      return{ok:true as const,entityId:next.id,revision:next.revision};
    });}catch(e){return{ok:false,error:e instanceof DomainError?{code:e.code,message:e.message}:{code:"VALIDATION",message:"故事状态未保存，请检查内容与来源"}};}
  }
  workspace(q:StoryQuery):StoryWorkspace{
    if(typeof q.projectId!=="string"||!q.projectId||q.beforeOrdinal!==undefined&&(!Number.isSafeInteger(q.beforeOrdinal)||q.beforeOrdinal<1)||q.offset!==undefined&&(!Number.isSafeInteger(q.offset)||q.offset<0)||q.limit!==undefined&&(!Number.isSafeInteger(q.limit)||q.limit<1||q.limit>40))throw new DomainError("VALIDATION","状态查询范围不正确");
    this.project(q.projectId);const offset=q.offset??0,limit=q.limit??40;
    const records=this.store.selectByProject("storyRecords",q.projectId),chapters=this.store.chapterMetadata(q.projectId),notes=this.store.selectByProject("notes",q.projectId),views=storyViews(records,chapters,notes);
    const {current,blockedCount}=currentStory(storyViews(acceptedStory(records,q.beforeOrdinal),chapters,notes),q.beforeOrdinal);
    const visible=views.filter(r=>!r.archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    return{records:visible.slice(offset,offset+limit),current:current.slice(0,40),foreshadowing:visible.filter(r=>r.kind==="foreshadowing").slice(0,40),total:visible.length,offset,nextOffset:offset+limit<visible.length?offset+limit:null,blockedCount};
  }
  capture(projectId:string,chapter:Chapter,proposals:unknown,origin:StoryOrigin):{ids:string[];warnings:string[]}{
    const ids:string[]=[],warnings:string[]=[];
    if(!Array.isArray(proposals)||proposals.length>20)return{ids,warnings:["状态候选格式或数量不正确，正文已保留"]};
    for(const raw of proposals){try{validateStoryProposal(raw);const p=raw as StoryProposal,start=chapter.content.indexOf(p.quote);
      if(start<0||chapter.content.indexOf(p.quote,start+1)>=0)throw new DomainError("VALIDATION","候选引用无法唯一对应正文");
      const {quote,...entry}=p,evidence=this.evidence(projectId,[{chapterId:chapter.id,revision:chapter.revision,start,end:start+quote.length}]);
      const fingerprint=(r:StoryRecord)=>JSON.stringify([storyEntry(r),r.evidence]);
      const known=this.store.selectByProject("storyRecords",projectId).find(r=>fingerprint(r)===JSON.stringify([storyEntry(entry),evidence]));
      if(known){if(known.status!=="rejected")ids.push(known.id);continue;}
      ids.push(this.save(projectId,entry,evidence,origin).id);
    }catch(e){warnings.push(e instanceof DomainError?e.message:"状态候选未保存，正文已保留");}}
    return{ids:[...new Set(ids)],warnings:[...new Set(warnings)]};
  }
}
