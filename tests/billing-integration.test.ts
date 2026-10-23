import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { AppServices } from '../src/main/services';
import type { Command, CommandResult, ModelPricing } from '../src/shared/types';
const closes: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
function id(result:CommandResult){if(!result.ok)throw Error(result.error.message);return result.entityId;}
async function fixture(retry=false){
 let calls=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;
  res.setHeader('content-type','application/json');
  if(retry&&calls===1){res.statusCode=503;res.end('{"error":{"message":"retry"}}');return;}
  res.end(JSON.stringify({choices:[{message:{content:'连接成功'}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:40}}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(join(tmpdir(),'billing-app-'));
 const app=new AppServices({dataDir:dir,dialogs:{open:async()=>null,save:async()=>null},provider:{retryDelayMs:1}});
 closes.push(async()=>{await app.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});});
 const baseUrl=`http://127.0.0.1:${(server.address() as any).port}`;
 const profile=async(name:string,pricing?:ModelPricing)=>id(await app.dispatch({type:'profile.save',name,model:'same-model',baseUrl,purpose:'writing',...(pricing?{pricing}:{})}));
 const start=async(profileId:string,budgetMicros?:number)=>app.dispatch({type:'model.test',profileId,...(budgetMicros!==undefined?{billing:{budgetMicros}}:{})} as unknown as Command);
 const finish=async(taskId:string)=>{await expect.poll(()=>app.snapshot().tasks.find(t=>t.id===taskId)?.status).not.toBe('running');return app.snapshot().tasks.find(t=>t.id===taskId)!;};
 return {app,profile,start,finish,get calls(){return calls;}};
}
describe('real service billing boundary with local mock HTTP',()=>{
 it('executes unpriced AI without approval and records unknown cost with reported usage',async()=>{
  const f=await fixture();const profileId=await f.profile('无需价格');
  const taskId=id(await f.start(profileId));
  expect((await f.finish(taskId)).status).toBe('completed');
  expect(f.calls).toBe(1);
  expect(f.app.billingSummary(taskId)).toMatchObject({unknown:true,spentMicros:0});
  expect(f.app.snapshot().tasks.find(t=>t.id===taskId)?.usage?.totalTokens).toBe(120);
 });
 it('executes priced AI despite a legacy zero money allowance',async()=>{
  const f=await fixture();const profileId=await f.profile('零旧预算',{currency:'CNY',input:1,output:2});
  const taskId=id(await f.start(profileId,0));
  expect((await f.finish(taskId)).status).toBe('completed');
  expect(f.calls).toBe(1);expect(f.app.billingSummary(taskId).spentMicros).toBe(140);
 });
 it('keeps estimates available without requiring approval',async()=>{
  const f=await fixture();const profileId=await f.profile('价格仅作统计',{currency:'CNY',input:1,output:2});
  expect(f.app.billingQuote({type:'model.test',profileId}).estimatedMicros).toBeGreaterThan(0);
  expect((await f.finish(id(await f.start(profileId)))).status).toBe('completed');expect(f.calls).toBe(1);
 });
 it('uses the selected profile price when endpoint and model match another profile',async()=>{
  const f=await fixture();await f.profile('便宜连接',{currency:'CNY',input:1,output:1});
  const expensive=await f.profile('贵连接',{currency:'CNY',input:10,output:20,cachedInput:2});
  const taskId=id(await f.start(expensive,1000000));expect((await f.finish(taskId)).status).toBe('completed');
  expect(f.calls).toBe(1);expect(f.app.billingSummary(taskId)).toMatchObject({spentMicros:1080,reservedMicros:0,unknown:false});
 });
 it('resumes a legacy failed task without a top-up and keeps usage history',async()=>{
  const f=await fixture();const profileId=await f.profile('有价连接',{currency:'CNY',input:1,output:2});
  const taskId=id(await f.start(profileId,1));await f.finish(taskId);
  const store=(f.app as any).store;const task=store.get('tasks',taskId);store.put('tasks',{...task,status:'failed',error:'旧金额预算不足'});
  const result=await f.app.dispatch({type:'task.resume',id:taskId,mode:'continue'} as Command);
  expect(result.ok).toBe(true);expect((await f.finish(taskId)).status).toBe('completed');expect(f.calls).toBe(2);
  expect(f.app.billingSummary(taskId).spentMicros).toBe(280);
 });
 it('retains unknown failed-attempt reservation and settles successful retry once',async()=>{
  const f=await fixture(true);const profileId=await f.profile('重试连接',{currency:'CNY',input:1,output:2,cachedInput:0.1});
  const taskId=id(await f.start(profileId,1000000));expect((await f.finish(taskId)).status).toBe('completed');
  const summary=f.app.billingSummary(taskId);expect(f.calls).toBe(2);expect(summary.spentMicros).toBe(104);expect(summary.reservedMicros).toBeGreaterThan(0);expect(summary.unknown).toBe(true);
 });
});
