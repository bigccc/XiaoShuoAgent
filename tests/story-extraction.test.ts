import {afterEach,expect,it} from "vitest";
import {AppServices} from "./support/test-app";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer,type ServerResponse} from "node:http";
import type {Command,CommandResult} from "../src/shared/types";
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function id(r:CommandResult){expect(r.ok,r.ok?"":r.error.message).toBe(true);if(!r.ok)throw Error(r.error.message);return r.entityId;}
const proposal={kind:"item",subject:"铜钥匙",attribute:"持有人",value:"老周",statement:"fact",storyTime:"",quote:"铜钥匙在老周手中。"};
function reply(res:ServerResponse,data:unknown,usage:any={prompt_tokens:10,completion_tokens:20,total_tokens:30}){res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(data)},finish_reason:"stop"}],...(usage?{usage}:{})}));}
async function setup(content="铜钥匙在老周手中。",custom?:(input:any,res:ServerResponse)=>boolean){
  const calls:any[]=[];const server=createServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),input=JSON.parse(body.messages.at(-1).content);calls.push(input);if(custom?.(input,res))return;reply(res,{states:input.passage.text.includes(proposal.quote)?[proposal]:[]});});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const dir=mkdtempSync(join(tmpdir(),"story-extract-"));let app=new AppServices({dataDir:dir,dialogs:{open:async()=>null,save:async()=>null},provider:{retryDelayMs:1}});
  cleanups.push(async()=>{await app.dispose();await new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());});rmSync(dir,{recursive:true,force:true});});
  const projectId=id(await app.dispatch({type:"project.create",title:"旧城"}));id(await app.dispatch({type:"profile.save", pricing: { currency: "CNY", input: 0, output: 0 },name:"fixture",purpose:"checking",baseUrl:`http://127.0.0.1:${(server.address() as any).port}`,model:"fixture"}));
  const chapterId=id(await app.dispatch({type:"chapter.create",projectId,ordinal:8,title:"第8章"}));id(await app.dispatch({type:"chapter.save",id:chapterId,revision:1,content}));
  return{app,projectId,chapterId,dir,calls,restart:async()=>{await app.dispose();app=new AppServices({dataDir:dir,dialogs:{open:async()=>null,save:async()=>null},provider:{retryDelayMs:1}});return app;}};
}
async function start(app:AppServices,projectId:string,chapterId:string,tokenBudget=100000){return id(await app.dispatch({type:"story.job.start",projectId,chapterIds:[chapterId],tokenBudget} as Command));}
async function done(app:AppServices,jobId:string){await expect.poll(()=>app.snapshot().storyJobs?.find(j=>j.id===jobId)?.status).not.toBe("running");return app.snapshot().storyJobs!.find(j=>j.id===jobId)!;}
it("extracts source-bound candidates without approving draft facts",async()=>{
  const f=await setup(),job=await done(f.app,await start(f.app,f.projectId,f.chapterId));expect(job.status).toBe("completed");expect(job.calls).toBe(1);expect(job.usage?.totalTokens).toBe(30);
  const r=f.app.snapshot().storyRecords![0];expect(r).toMatchObject({status:"candidate",value:"老周",origin:{kind:"extraction",id:job.id}});expect(r.evidence[0].quote).toBe(proposal.quote);
  expect(f.app.storyWorkspace({projectId:f.projectId}).current).toEqual([]);
});
it("segments long chapters and resumes checkpoints after a restart without paying automatically",async()=>{
  let blocked=false;const f=await setup(proposal.quote+"雨落。".repeat(7000),(input,_res)=>{if(input.passage.start>0&&!blocked){blocked=true;return true;}return false;});
  const jobId=await start(f.app,f.projectId,f.chapterId);await expect.poll(()=>blocked).toBe(true);expect(f.app.snapshot().storyRecords).toHaveLength(1);
  const reopened=await f.restart();expect(reopened.snapshot().storyJobs![0].status).toBe("interrupted");const before=f.calls.length;
  await new Promise(r=>setTimeout(r,25));expect(f.calls).toHaveLength(before);
  id(await reopened.dispatch({type:"story.job.resume",id:jobId,tokenBudget:200000}));const job=await done(reopened,jobId);
  expect(job.status).toBe("completed");expect(reopened.snapshot().storyRecords).toHaveLength(1);expect(job.budgetUsed).toBeGreaterThan(30);expect(f.calls.every(c=>c.passage.text.length<=16000)).toBe(true);
});
it("pauses before an over-budget request and settles unknown usage conservatively",async()=>{
  const f=await setup(proposal.quote,(_i,res)=>{reply(res,{states:[proposal]},null);return true;});const jobId=await start(f.app,f.projectId,f.chapterId,1);let job=await done(f.app,jobId);expect(job.status).toBe("paused");expect(f.calls).toHaveLength(0);
  id(await f.app.dispatch({type:"story.job.resume",id:jobId,tokenBudget:100000}));job=await done(f.app,jobId);expect(job.status).toBe("completed");expect(job.budgetUsed).toBeGreaterThan(0);expect(job.usage?.estimated).toBe(true);
});
it("rejects a source edit made during a model call without writing late candidates",async()=>{
  let release:(()=>void)|undefined;const f=await setup(proposal.quote,(_input,res)=>{release=()=>reply(res,{states:[proposal]});return true;});const jobId=await start(f.app,f.projectId,f.chapterId);await expect.poll(()=>!!release).toBe(true);
  id(await f.app.dispatch({type:"chapter.save",id:f.chapterId,revision:2,content:"铜钥匙已交给阿宁。"}));release!();const job=await done(f.app,jobId);expect(job.status).toBe("failed");expect(f.app.snapshot().storyRecords).toEqual([]);
  expect((await f.app.dispatch({type:"story.job.resume",id:jobId})).ok).toBe(false);
});
it("does not accept an invented quote or turn invalid output into confirmed facts",async()=>{
  const f=await setup(proposal.quote,(_i,res)=>{reply(res,{states:[{...proposal,quote:"正文没有这句话。"}]});return true;});const job=await done(f.app,await start(f.app,f.projectId,f.chapterId));expect(job.candidateIds).toEqual([]);expect(job.warnings.length).toBeGreaterThan(0);expect(f.app.snapshot().storyRecords).toEqual([]);
});
it("cancels a pending extraction and preserves cancellation after late network data",async()=>{
  let received=false;const f=await setup(proposal.quote,()=>{received=true;return true;});const jobId=await start(f.app,f.projectId,f.chapterId);await expect.poll(()=>received).toBe(true);id(await f.app.dispatch({type:"story.job.cancel",id:jobId}));const job=await done(f.app,jobId);expect(job.status).toBe("cancelled");expect(f.app.snapshot().storyRecords).toEqual([]);
});


it("continues imported checkpoints using the local connection only after an explicit resume",async()=>{
  const {ProjectFiles}=await import("../src/main/files");const {Store}=await import("../src/main/store");
  const f=await setup();
  const secondId=id(await f.app.dispatch({type:"chapter.create",projectId:f.projectId,ordinal:9,title:"雨夜"}));
  id(await f.app.dispatch({type:"chapter.save",id:secondId,revision:1,content:"风声。".repeat(7000)}));
  const originalId=id(await f.app.dispatch({type:"story.job.start",projectId:f.projectId,chapterIds:[f.chapterId,secondId],tokenBudget:10000}));
  const original=await done(f.app,originalId);expect(original.status).toBe("paused");expect(original.cursor).toBe(1);expect(original.candidateIds).toHaveLength(1);
  const fileStore=new Store(join(f.dir,"works.sqlite")),files=new ProjectFiles(fileStore),path=join(f.dir,"import.novel");
  let projectId:string;try{await files.backup(f.projectId,path);projectId=await files.importBackup(path);}finally{fileStore.close();}
  const j=f.app.snapshot().storyJobs!.find(j=>j.projectId===projectId)!;
  expect(j.profileId).toBeUndefined();expect(j.cursor).toBe(1);expect(j.budgetUsed).toBe(original.budgetUsed);expect(j.candidateIds).toHaveLength(1);
  const before=f.calls.length;await new Promise(r=>setTimeout(r,25));expect(f.calls).toHaveLength(before);
  id(await f.app.dispatch({type:"story.job.resume",id:j.id,tokenBudget:100000}));
  const finished=await done(f.app,j.id);expect(finished.status).toBe("completed");expect(f.calls.length).toBeGreaterThan(before);
  expect(finished.profileId).toBeTruthy();expect(finished.cursor).toBe(2);expect(finished.candidateIds).toHaveLength(1);
  expect(f.calls.slice(before).every(input=>input.chapter.id!==f.chapterId)).toBe(true);
});
