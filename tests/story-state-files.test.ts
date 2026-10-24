import {afterEach,expect,it} from "vitest";
import {Store} from "../src/main/store";
import {DomainService} from "../src/main/domain";
import {StoryStateService} from "../src/main/story-state";
import {storyContext,storyStampCurrent} from "../src/main/story-context";
import {validateRevisionJob,type RevisionJob} from "../src/shared/revision";
import {ProjectFiles} from "../src/main/files";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
const stores:Store[]=[],dirs:string[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
function fixture(){const dir=mkdtempSync(join(tmpdir(),"story-pack-"));dirs.push(dir);const store=new Store(":memory:");stores.push(store);const domain=new DomainService(store),story=new StoryStateService(store);const p=domain.execute({type:"project.create",title:"旧城"});if(!p.ok)throw Error();const c=domain.execute({type:"chapter.create",projectId:p.entityId,ordinal:8,title:"第8章"});if(!c.ok)throw Error();const content="铜钥匙在老周手中。";domain.execute({type:"chapter.save",id:c.entityId,revision:1,content});domain.execute({type:"chapter.confirm",id:c.entityId,revision:2});const r=story.command({type:"story.save",projectId:p.entityId,entry:{kind:"item",subject:"铜钥匙",attribute:"持有人",value:"老周",statement:"fact",storyTime:""},evidence:[{chapterId:c.entityId,revision:3,start:0,end:content.length}]});if(!r.ok)throw Error(r.error.message);story.command({type:"story.confirm",id:r.entityId,revision:r.revision!});return{dir,store,domain,story,projectId:p.entityId,chapterId:c.entityId,recordId:r.entityId,files:new ProjectFiles(store)};}
function write(path:string,pack:any){pack.sha256=createHash("sha256").update(JSON.stringify(pack.payload)).digest("hex");writeFileSync(path,JSON.stringify(pack));}
it("round-trips accepted state and historical evidence using new identities",async()=>{
  const f=fixture(),path=join(f.dir,"book.novel");await f.files.backup(f.projectId,path);
  const pack=JSON.parse(readFileSync(path,"utf8"));expect(pack.version).toBe(9);expect(pack.payload.storyRecords).toHaveLength(1);
  const imported=await f.files.importBackup(path),record=f.store.selectByProject("storyRecords",imported)[0];
  expect(record.id).not.toBe(f.recordId);expect(record.evidence[0].chapterId).not.toBe(f.chapterId);
  expect(record.accepted?.evidence[0].chapterId).toBe(record.evidence[0].chapterId);
  expect(record.history[0].evidence[0].chapterId).toBe(record.evidence[0].chapterId);
  expect(f.story.workspace({projectId:imported}).current[0].value).toBe("老周");
});
it("normalizes v5 packages without losing manuscript or fabricating story records",async()=>{
  const f=fixture(),path=join(f.dir,"old.novel");await f.files.backup(f.projectId,path);
  const pack=JSON.parse(readFileSync(path,"utf8"));pack.version=5;delete pack.payload.storyRecords;delete pack.payload.storyJobs;write(path,pack);
  const imported=await f.files.importBackup(path);expect(f.store.selectByProject("chapters",imported)[0].content).toBe("铜钥匙在老周手中。");expect(f.store.selectByProject("storyRecords",imported)).toEqual([]);
});
it("rejects forged current evidence and foreign evidence atomically",async()=>{
  const f=fixture(),path=join(f.dir,"bad.novel");await f.files.backup(f.projectId,path);const original=JSON.parse(readFileSync(path,"utf8"));
  const pack=JSON.parse(JSON.stringify(original));pack.payload.storyRecords[0].evidence[0].quote="铜钥匙在阿宁手中。";write(path,pack);
  await expect(f.files.importBackup(path)).rejects.toThrow(/来源|原文|状态/);expect(f.store.list("projects")).toHaveLength(1);
  const foreign=JSON.parse(JSON.stringify(original));foreign.format="xiaoshuo-recovery";foreign.payload.schemaVersion=9;
  foreign.payload.projects.push({...foreign.payload.projects[0],id:"other"});foreign.payload.chapters.push({...foreign.payload.chapters[0],id:"foreign",projectId:"other"});foreign.payload.storyRecords[0].evidence[0].chapterId="foreign";write(path,foreign);
  await expect(f.files.importBackup(path)).rejects.toThrow(/来源|跨作品|归属/);expect(f.store.list("projects")).toHaveLength(1);
});
it("retains deleted historical sources as stale records without linking them to the original work",async()=>{
  const f=fixture();f.store.remove("chapters",f.chapterId);f.store.list("versions").forEach(v=>f.store.remove("versions",v.id));
  const path=join(f.dir,"deleted.novel");await f.files.backup(f.projectId,path);const imported=await f.files.importBackup(path),record=f.store.selectByProject("storyRecords",imported)[0];
  expect(record.evidence[0].chapterId).not.toBe(f.chapterId);expect(f.story.workspace({projectId:imported}).blockedCount).toBe(1);
});
it("rejects an accepted snapshot with no fact evidence instead of promoting an unbacked value",async()=>{
  const f=fixture(),path=join(f.dir,"empty-accepted.novel");await f.files.backup(f.projectId,path);const pack=JSON.parse(readFileSync(path,"utf8"));
  pack.payload.storyRecords[0].accepted.evidence=[];write(path,pack);
  await expect(f.files.importBackup(path)).rejects.toThrow(/来源|状态|证据/);expect(f.store.list("projects")).toHaveLength(1);
});

it("rebases a revision job story stamp after chapter and record identities change",async()=>{
  const f=fixture(),path=join(f.dir,"story-revision.novel"),content="铜钥匙在老周手中。",next="铜钥匙在阿宁手中。";
  const chapter=f.store.get("chapters",f.chapterId)!,project=f.store.get("projects",f.projectId)!,now=new Date().toISOString();
  const storyStamp=storyContext(f.store.snapshot(),f.projectId,9).stamp;
  const job:RevisionJob={id:"story-revision",revision:1,createdAt:now,updatedAt:now,projectId:f.projectId,storyStamp,text:"只修正物品持有人",scope:"chapters",chapterIds:[f.chapterId],annotationIds:[],status:"awaiting-author",tokenBudget:1000,usage:null,calls:0,checkedChapterIds:[f.chapterId],candidates:[{chapterId:f.chapterId,sourceRevision:chapter.revision,title:chapter.title,baseTitle:chapter.title,baseContent:content,content:next,status:"pending"}],notes:[],sourceProjectRevision:project.revision,chapterSources:[{chapterId:f.chapterId,revision:chapter.revision,digest:createHash("sha256").update(JSON.stringify([content,chapter.title,chapter.style,chapter.pace])).digest("hex")}],referenceChapterSources:[],noteSources:[],warnings:[],reply:"待审",materialsStatus:"pending"};
  validateRevisionJob(job);f.store.put("revisionJobs",job);
  await f.files.backup(f.projectId,path);
  const imported=await f.files.importBackup(path),candidate=f.store.selectByProject("revisionJobs",imported)[0];
  expect(candidate.storyStamp).toBeDefined();
  expect(candidate.storyStamp!.digest).not.toBe(storyStamp.digest);
  expect(storyStampCurrent(f.store.snapshot(),imported,candidate.storyStamp!)).toBe(true);
  expect(candidate.candidates[0].chapterId).not.toBe(f.chapterId);
});
