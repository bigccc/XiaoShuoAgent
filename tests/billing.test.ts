import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BillingService } from '../src/main/billing';
import { Store } from '../src/main/store';
import { DomainService } from '../src/main/domain';
import { billable, costMicros } from '../src/shared/billing';
import type { ModelPricing, TaskUsage } from '../src/shared/types';
import type { ChatRequest } from '../src/main/provider';
const cleanups: (()=>void)[]=[];
afterEach(()=>{ for(const close of cleanups.splice(0).reverse())close(); });
const pricing: ModelPricing={ currency:'CNY', input:1.5, output:3, cachedInput:0.25 };
const command={type:'model.test',profileId:'profile',billing:{budgetMicros:0}};
const request:ChatRequest={baseUrl:'https://example.com',model:'model',messages:[{role:'system',content:'测试'}],maxTokens:10};
const reservedInput=Buffer.byteLength(request.messages[0].content,'utf8')+64+128;
const usage=(input=4,output=2):TaskUsage=>({inputTokens:input,outputTokens:output,totalTokens:input+output,estimated:false});
function fixture(price:ModelPricing|undefined=pricing,path=':memory:') {
 const store=new Store(path),domain=new DomainService(store);
 const result=domain.execute({type:'profile.save', name:'测试模型',baseUrl:request.baseUrl,model:request.model,purpose:'writing',...(price?{pricing:price}:{})});
 if(!result.ok) throw Error(result.error.message);
 const billing=new BillingService(store);cleanups.push(()=>store.close());
 return {store,domain,billing,command:{...command,profileId:result.entityId}};
}
describe('persistent usage accounting',()=>{
 it('runs unpriced models without authorization and keeps unknown request records',async()=>{
  const f=fixture();const profile=f.store.list('profiles')[0];delete profile.pricing;f.store.put('profiles',profile);
  const result=await f.billing.dispatch({type:'model.test',profileId:profile.id},async()=>{
   f.billing.settle(f.billing.reserve(request),usage());return {ok:true,entityId:'task'};
  });
  expect(result.ok).toBe(true);expect(f.billing.summary('task')).toMatchObject({unknown:true,spentMicros:0});
  const row=f.store.billingDatabase().prepare('SELECT pricing,usage,status FROM billingRequests').get()!;
  expect(JSON.parse(String(row.usage))).toMatchObject({totalTokens:6});expect(row.status).toBe('unknown');expect(row.pricing).toBe('null');
 });
 it('ignores legacy money limits and reuses the ledger on resume',async()=>{
  const f=fixture();
  for(const c of [{...f.command,billing:{budgetMicros:0}},{type:'task.resume',id:'task'}])
   await f.billing.dispatch(c,async()=>{f.billing.settle(f.billing.reserve(request),usage());return {ok:true,entityId:'task'};});
  expect(f.billing.summary('task')).toMatchObject({spentMicros:24,reservedMicros:0,unknown:false});
 });
 it('settles using the historical price and is idempotent',async()=>{
  const f=fixture();
  await f.billing.dispatch(f.command,async()=>{
   const id=f.billing.reserve(request);
   const p=f.store.list('profiles')[0];p.pricing={currency:'CNY',input:100,output:200};f.store.put('profiles',p);
   f.billing.settle(id,usage());f.billing.settle(id,usage(100,100));
   return {ok:true,entityId:'task'};
  });
  expect(f.billing.summary('task')).toMatchObject({spentMicros:12,reservedMicros:0,budgetMicros:0,unknown:false});
 });
 it('charges cache input at its configured price and rounds only to micro-yuan',async()=>{
  const f=fixture();
  await f.billing.dispatch(f.command,async()=>{
   const id=f.billing.reserve(request);f.billing.settle(id,{...usage(8,1),cachedInputTokens:4} as TaskUsage);
   return {ok:true,entityId:'task'};
  });
  expect(f.billing.summary('task').spentMicros).toBe(10);
  expect(costMicros({currency:'CNY',input:0.000001,output:0.000001},1,1)).toBe(1);
 });
 it('reserves every failed retry and keeps unknown usage occupied',async()=>{
  const f=fixture();
  await f.billing.dispatch(f.command,async()=>{
   for(let i=0;i<3;i++)f.billing.settle(f.billing.reserve(request));
   f.billing.settle(f.billing.reserve(request),usage());return {ok:true,entityId:'task'};
  });
  expect(f.billing.summary('task')).toMatchObject({spentMicros:12,reservedMicros:3*costMicros(pricing,reservedInput,10),unknown:true});
 });
 it('records concurrent requests without a cumulative limit',async()=>{
  const f=fixture();const single=costMicros(pricing,reservedInput,10);
  await f.billing.dispatch({...f.command,billing:{budgetMicros:single}},async()=>{
   const ids=await Promise.all([0,1].map(async()=>f.billing.reserve(request)));
   expect(new Set(ids).size).toBe(2);return {ok:true,entityId:'task'};
  });
  expect(f.billing.summary('task').reservedMicros).toBe(single*2);
 });
 it('retains interrupted reservations on restart and cannot settle twice',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'novel-billing-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fixture(pricing,join(dir,'data.sqlite'));let id='';
  await f.billing.dispatch(f.command,async()=>{id=f.billing.reserve(request);return {ok:true,entityId:'task'};});
  cleanups.pop()!();
  const reopened=new Store(join(dir,'data.sqlite'));cleanups.push(()=>reopened.close());const billing=new BillingService(reopened);
  expect(billing.summary('task')).toMatchObject({reservedMicros:costMicros(pricing,reservedInput,10),unknown:true});
  billing.settle(id,usage());
  expect(billing.summary('task').spentMicros).toBe(0);
 });
 it('lets explicit free models run with an explicit zero budget',async()=>{
  const f=fixture({currency:'CNY',input:0,output:0});let calls=0;
  await f.billing.dispatch({...f.command,billing:{budgetMicros:0}},async()=>{const id=f.billing.reserve(request);calls++;f.billing.settle(id,usage());return {ok:true,entityId:'task'};});
  expect(calls).toBe(1);expect(f.billing.summary('task')).toMatchObject({spentMicros:0,reservedMicros:0,budgetMicros:0});
 });
 it('keeps every retry owner attached to one historical ledger',async()=>{
  const f=fixture();
  await f.billing.dispatch(f.command,async()=>{f.billing.settle(f.billing.reserve(request),usage());return {ok:true,entityId:'original'};});
  await f.billing.dispatch({type:'conversation.retry',id:'original'},async()=>{f.billing.settle(f.billing.reserve(request),usage());return {ok:true,entityId:'retried'};});
  expect(f.billing.summary('original')).toEqual(f.billing.summary('retried'));
  expect(f.billing.summary('original')).toMatchObject({spentMicros:24,budgetMicros:0});
 });
 it('clears a legacy blocked amount when an ordinary resume sends work',async()=>{
  const f=fixture();
  await f.billing.dispatch(f.command,async()=>({ok:true,entityId:'original'}));
  f.store.billingDatabase().prepare('UPDATE billingBudgets SET next=123,budget=0').run();
  await f.billing.dispatch({type:'task.resume',id:'original'},async()=>{f.billing.settle(f.billing.reserve(request),usage());return {ok:true,entityId:'retried'};});
  expect(f.billing.summary('original')).toMatchObject({spentMicros:12,nextMicros:0});expect(f.billing.summary('retried')).toEqual(f.billing.summary('original'));
 });
 it('quotes one hundred chapters higher than one for explicit goals and natural language',()=>{
  const f=fixture();const projectId=f.domain.execute({type:'project.create',title:'长篇'});if(!projectId.ok)throw Error();
  const base={type:'writing.start',projectId:projectId.entityId,profileId:f.command.profileId};
  expect(f.billing.quote({...base,goal:{startOrdinal:1,endOrdinal:100}}).estimatedMicros).toBeGreaterThan(f.billing.quote({...base,goal:{startOrdinal:1,endOrdinal:1}}).estimatedMicros);
  const chat={type:'conversation.send',projectId:projectId.entityId,profileId:f.command.profileId};
  expect(f.billing.quote({...chat,text:'连续写100章'}).estimatedMicros).toBeGreaterThan(f.billing.quote({...chat,text:'连续写1章'}).estimatedMicros);
 });
 it.each([['voice.extract','planning'],['scene.plan','planning'],['story.job.start','checking'],['ai.check','checking'],['conversation.send','writing']])('quotes the actual default model for %s', (type,purpose)=>{
  const f=fixture();const original=f.store.list('profiles')[0];f.store.remove('profiles',original.id);
  for(const role of ['writing','planning','checking'] as const) {
   const saved=f.domain.execute({type:'profile.save',name:role,baseUrl:request.baseUrl,model:role,purpose:role,...(role!==purpose?{pricing}:{})});if(!saved.ok)throw Error();
  }
  expect(f.billing.quote({type,projectId:'book',text:'聊聊故事'})).toMatchObject({priced:false,missingProfiles:[purpose]});
 });
 it('reserves at least UTF-8 content bytes plus message overhead for Chinese and emoji',async()=>{
  const f=fixture({currency:'CNY',input:1,output:0});const content='中文🙂'.repeat(100);
  await f.billing.dispatch({...f.command,billing:{budgetMicros:0}},async()=>{f.billing.reserve({...request,messages:[{role:'user',content}],maxTokens:1});return {ok:true,entityId:'task'};});
  expect(f.billing.summary('task').reservedMicros).toBeGreaterThanOrEqual(Buffer.byteLength(content,'utf8')+64+128);
 });
 it('runs local and AI draft conflict resolutions without money authorization',async()=>{
  const f=fixture();let calls=0;
  for(const resolution of ['records','draft'])expect((await f.billing.dispatch({type:'authoring.resolveSync',id:'conflict',resolution},async()=>{calls++;return {ok:true,entityId:'conflict'};})).ok).toBe(true);
  expect(calls).toBe(2);
 });
 it('records background work under its owner outside a command scope',()=>{
  const f=fixture();f.billing.settle(f.billing.reserve({...request,billingOwnerId:'background-job',billingProjectId:'book'}),usage());
  expect(f.billing.summary('background-job')).toMatchObject({spentMicros:12,unknown:false});
 });
 it.each(['conversation.send','writing.start','writing.resume','revision.start','revision.resume','ai.generate','ai.check','ai.extract','model.test','voice.extract','scene.plan','scene.revise','structure.revise','story.job.start','authoring.sync','authoring.retrySync','task.resume'])('recognizes accounted entry %s',(type)=>{expect(billable(type)).toBe(true);});
});
