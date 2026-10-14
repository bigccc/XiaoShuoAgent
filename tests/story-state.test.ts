import {afterEach,expect,it} from "vitest";
import {Store} from "../src/main/store";
import {DomainService} from "../src/main/domain";
import {StoryStateService} from "../src/main/story-state";
import type {StoryEntry,StoryCommand,StoryEvidenceInput} from "../src/shared/story-state";
import type {CommandResult} from "../src/shared/types";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const stores:Store[]=[], dirs:string[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
function id(r:CommandResult){expect(r.ok,r.ok?"":r.error.message).toBe(true);if(!r.ok)throw Error(r.error.message);return r.entityId;}
function setup(){const store=new Store(":memory:");stores.push(store);const domain=new DomainService(store);const projectId=id(domain.execute({type:"project.create",title:"旧城"}));return{store,domain,projectId,story:new StoryStateService(store)};}
function source(f:ReturnType<typeof setup>,ordinal:number,text:string,confirm=true):StoryEvidenceInput{
  const chapterId=id(f.domain.execute({type:"chapter.create",projectId:f.projectId,ordinal,title:`第${ordinal}章`}));
  id(f.domain.execute({type:"chapter.save",id:chapterId,revision:1,content:text}));
  if(confirm)id(f.domain.execute({type:"chapter.confirm",id:chapterId,revision:2}));
  return{chapterId,revision:confirm?3:2,start:0,end:text.length};
}
const entry=(value:string,extra:Partial<StoryEntry>={}):StoryEntry=>({kind:"item",subject:"铜钥匙",attribute:"持有人",value,statement:"fact",storyTime:"",...extra});
function save(f:ReturnType<typeof setup>,value:string,evidence:StoryEvidenceInput[],extra:Partial<StoryEntry>={}){
  return id(f.story.command({type:"story.save",projectId:f.projectId,entry:entry(value,extra),evidence}));
}
function act(f:ReturnType<typeof setup>,recordId:string,type:"story.confirm"|"story.reject"|"story.recheck"){
  return f.story.command({type,id:recordId,revision:f.story.record(recordId).revision});
}
it("stores candidates separately and projects a normal transfer at the requested story position",()=>{
  const f=setup(),a=save(f,"老周",[source(f,8,"铜钥匙在老周手中。")]);
  expect(f.story.workspace({projectId:f.projectId}).current).toEqual([]);
  id(act(f,a,"story.confirm"));
  const b=save(f,"阿宁",[source(f,120,"老周将铜钥匙交给阿宁。")]);
  expect(f.story.workspace({projectId:f.projectId}).current[0].value).toBe("老周");
  id(act(f,b,"story.confirm"));
  expect(f.story.workspace({projectId:f.projectId}).current[0].value).toBe("阿宁");
  expect(f.story.workspace({projectId:f.projectId,beforeOrdinal:120}).current[0].value).toBe("老周");
});
it("keeps the accepted version active while an edit is pending, rejected or restored",()=>{
  const f=setup(),e=source(f,8,"铜钥匙在老周手中。"),r=save(f,"老周",[e]);id(act(f,r,"story.confirm"));
  id(f.story.command({type:"story.save",projectId:f.projectId,id:r,revision:f.story.record(r).revision,entry:entry("阿宁"),evidence:[e]}));
  expect(f.story.workspace({projectId:f.projectId}).current[0]?.value).toBe("老周");
  id(act(f,r,"story.reject"));expect(f.story.workspace({projectId:f.projectId}).current[0]?.value).toBe("老周");
});
it.each(["plan","guess","lie","recollection"] as const)("keeps %s out of current factual state",statement=>{
  const f=setup(),a=save(f,"老周",[source(f,8,"铜钥匙在老周手中。")]);id(act(f,a,"story.confirm"));
  const b=save(f,"阿宁",[source(f,120,"阿宁想起当年曾保管铜钥匙。")],{statement});id(act(f,b,"story.confirm"));
  expect(f.story.workspace({projectId:f.projectId}).current[0].value).toBe("老周");
});
it("blocks stable facts from drafts and permits explicit adoption after unchanged prose is confirmed",()=>{
  const f=setup(),e=source(f,8,"铜钥匙在老周手中。",false),r=save(f,"老周",[e]);
  expect(act(f,r,"story.confirm").ok).toBe(false);
  id(f.domain.execute({type:"chapter.confirm",id:e.chapterId,revision:e.revision}));
  id(act(f,r,"story.confirm"));expect(f.story.workspace({projectId:f.projectId}).current[0].value).toBe("老周");
});
it("marks a changed latest source unknown instead of pretending the older state is current",()=>{
  const f=setup(),a=save(f,"老周",[source(f,8,"铜钥匙在老周手中。")]);id(act(f,a,"story.confirm"));
  const e=source(f,120,"铜钥匙交给阿宁。"),b=save(f,"阿宁",[e]);id(act(f,b,"story.confirm"));
  id(f.domain.execute({type:"chapter.save",id:e.chapterId,revision:e.revision,content:"铜钥匙交给阿宁。窗外雨停了。"}));
  expect(f.story.workspace({projectId:f.projectId}).current).toEqual([]);
  expect(f.story.workspace({projectId:f.projectId}).blockedCount).toBe(1);
  expect(act(f,b,"story.confirm").ok).toBe(false);
  id(act(f,b,"story.recheck"));expect(f.story.record(b).status).toBe("candidate");
});
it("requires both planted and resolved evidence and keeps plans out of occurred facts",()=>{
  const f=setup(),r=save(f,"钥匙上的暗号",[],{kind:"foreshadowing",statement:"plan",foreshadowingStage:"planned"});id(act(f,r,"story.confirm"));
  expect(f.story.workspace({projectId:f.projectId}).current).toEqual([]);
  const e=source(f,8,"铜钥匙上的刻痕像某种暗号。");
  const bad=f.story.command({type:"story.save",projectId:f.projectId,id:r,revision:f.story.record(r).revision,entry:entry("暗号已解开",{kind:"foreshadowing",foreshadowingStage:"resolved"}),evidence:[e]});
  expect(bad.ok).toBe(false);
  const resolved=source(f,120,"阿宁终于解开铜钥匙上的暗号。");
  id(f.story.command({type:"story.save",projectId:f.projectId,id:r,revision:f.story.record(r).revision,entry:entry("暗号已解开",{kind:"foreshadowing",foreshadowingStage:"resolved"}),evidence:[e,resolved]}));
  id(act(f,r,"story.confirm"));expect(f.story.workspace({projectId:f.projectId}).foreshadowing[0].foreshadowingStage).toBe("resolved");
});
it("retains history when editing, rejecting and restoring a record without restoring approval",()=>{
  const f=setup(),e=source(f,8,"铜钥匙在老周手中。"),r=save(f,"老周",[e]);id(act(f,r,"story.confirm"));
  const oldRevision=f.story.record(r).revision;
  id(f.story.command({type:"story.save",projectId:f.projectId,id:r,revision:oldRevision,entry:entry("阿宁"),evidence:[e]}));
  id(act(f,r,"story.reject"));
  id(f.story.command({type:"story.restore",id:r,revision:f.story.record(r).revision,historyRevision:oldRevision}));
  expect(f.story.record(r)).toMatchObject({status:"candidate",value:"老周"});
  expect(f.story.record(r).history.length).toBeGreaterThan(1);
});
it("rejects foreign evidence, stale offsets and a late update without partially changing records",()=>{
  const f=setup(),e=source(f,8,"铜钥匙在老周手中。"),r=save(f,"老周",[e]);
  const other=id(f.domain.execute({type:"project.create",title:"其他作品"}));
  expect(f.story.command({type:"story.save",projectId:other,entry:entry("老周"),evidence:[e]}).ok).toBe(false);
  expect(f.story.command({type:"story.save",projectId:f.projectId,entry:entry("老周"),evidence:[{...e,end:9999}]}).ok).toBe(false);
  expect(f.story.command({type:"story.reject",id:r,revision:99}).ok).toBe(false);
  expect(f.story.workspace({projectId:f.projectId}).total).toBe(1);
});
it("migrates v5 only after a readable backup preserving the older database",()=>{
  const dir=mkdtempSync(join(tmpdir(),"story-migrate-"));dirs.push(dir);const path=join(dir,"works.sqlite");
  const old=new Store(path);old.close();const db=new DatabaseSync(path);db.exec("DROP TABLE IF EXISTS storyRecords; DROP TABLE IF EXISTS storyJobs; PRAGMA user_version=5;");db.close();
  const upgraded=new Store(path);stores.push(upgraded);expect(upgraded.snapshot().schemaVersion).toBe(8);
  const backup=readdirSync(dir).find(p=>p.includes("before-v6"));expect(backup).toBeTruthy();
  const saved=new DatabaseSync(join(dir,backup!),{readOnly:true});expect(saved.prepare("PRAGMA user_version").get()?.user_version).toBe(5);saved.close();
});

it("selects the latest foreshadowing lifecycle before validation and never resurrects stale planted evidence",async()=>{
  const {storyContext}=await import("../src/main/story-context");
  const f=setup(),plant=source(f,8,"钥匙刻痕像一串暗号。"),payoff=source(f,120,"阿宁解开暗号。");
  const a=save(f,"暗号已埋设",[plant],{kind:"foreshadowing",foreshadowingStage:"planted"});
  const b=save(f,"暗号已解开",[plant,payoff],{kind:"foreshadowing",foreshadowingStage:"resolved"});
  id(act(f,b,"story.confirm"));id(act(f,a,"story.confirm"));
  expect(storyContext(f.store.snapshot(),f.projectId,121).documents.every(d=>d.label.includes("resolved"))).toBe(true);
  id(f.domain.execute({type:"chapter.save",id:payoff.chapterId,revision:payoff.revision,content:"阿宁解开暗号。雨停了。"}));
  expect(storyContext(f.store.snapshot(),f.projectId,121).documents).toEqual([]);
  expect(f.story.workspace({projectId:f.projectId}).blockedCount).toBe(1);
  expect(storyContext(f.store.snapshot(),f.projectId,120).documents[0]?.label).toContain("planted");
});
it("retains separate clues bound to one character and preserves clue names when rechecking",async()=>{
  const {storyContext}=await import("../src/main/story-context");const f=setup();
  const entityNoteId=id(f.domain.execute({type:"note.save",projectId:f.projectId,noteType:"character",title:"阿宁",body:"调查者",sources:[]}));
  const e=source(f,8,"铜钥匙有暗号，旧信失踪了。");
  for(const subject of ["钥匙暗号","失踪旧信"]){const r=save(f,"已埋设",[e],{kind:"foreshadowing",foreshadowingStage:"planted",subject,attribute:"线索",entityNoteId});id(act(f,r,"story.confirm"));}
  expect(storyContext(f.store.snapshot(),f.projectId,9).documents).toHaveLength(2);
  const r=f.store.list("storyRecords")[0];id(act(f,r.id,"story.recheck"));expect(f.story.record(r.id).subject).toBe("钥匙暗号");
});
it("pages archived records separately and restores them after reopening the service",()=>{
  const f=setup();for(let i=0;i<42;i++){const r=save(f,`计划${i}`,[],{statement:"plan",subject:`记录${i}`});id(f.story.command({type:"story.archive",id:r,revision:1,archived:true}));}
  const reopened=new StoryStateService(f.store);expect(reopened.workspace({projectId:f.projectId}).total).toBe(0);
  const first=reopened.workspace({projectId:f.projectId,archived:true} as any);expect(first.records).toHaveLength(40);expect(first.nextOffset).toBe(40);
  const last=reopened.workspace({projectId:f.projectId,archived:true,offset:40} as any);expect(last.records).toHaveLength(2);
  const r=last.records[0];id(reopened.command({type:"story.archive",id:r.id,revision:r.revision,archived:false}));expect(reopened.workspace({projectId:f.projectId}).total).toBe(1);
  expect(reopened.workspace({projectId:f.projectId,archived:true} as any).total).toBe(41);
});
