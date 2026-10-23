import { Store } from "../src/main/store";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { AppServices } from "../src/main/services";
import type { Command, CommandResult } from "../src/shared/types";
import { chapter, meta } from "./fixtures/recall-cases";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function id(r: CommandResult) { if (!r.ok) throw Error(r.error.message); return r.entityId; }
function reply(res: ServerResponse, value: unknown, usage: unknown = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage }));
}
async function setup(custom?: (phase: string, input: any, res: ServerResponse) => boolean | void, options = {}) {
  const calls: { phase: string; input: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), phase = body.messages[0].content;
    let input: any; try { input = JSON.parse(body.messages.at(-1).content); } catch { input = body.messages.at(-1).content; }
    calls.push({ phase, input });
    if (custom?.(phase, input, res)) return;
    if (phase.includes("连续写作·规划")) reply(res, { plan: "遵循原设定，逐章推进线索，不改变主角身份。", majorChange: false, reason: "" });
    else if (phase.includes("连续写作·生成") || phase.includes("连续写作·修订")) reply(res, { title: `第${input.ordinal}章`, content: "雨落在窗前。".repeat(20), majorChange: false, reason: "" });
    else reply(res, { issues: [], majorChange: false, reason: "" });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "novel-writing-"));
  let app = new AppServices({ dataDir: dir, dialogs: { open: async () => null, save: async () => null }, provider: { retryDelayMs: 1 }, ...options });
  cleanups.push(async () => { await app.dispose(); await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); rmSync(dir, { recursive: true, force: true }); });
  const projectId = id(await app.dispatch({ type: "project.create", title: "雨城", chapterWords: 120 }));
  id(await app.dispatch({ type: "profile.save", name: "fixture", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, purpose: "writing" }));
  return { app, projectId, calls, dir, restart: async () => { await app.dispose(); app = new AppServices({ dataDir: dir, dialogs: { open: async () => null, save: async () => null }, provider: { retryDelayMs: 1 }, ...options }); return app; } };
}
async function start(app: AppServices, projectId: string, text = "写完前五章", tokenBudget = 100000) {
  return id(await app.dispatch({ type: "conversation.send", projectId, text, tokenBudget }));
}
async function done(app: AppServices, taskId: string) {
  await expect.poll(() => app.snapshot().writingJobs?.find(j => j.id === taskId)?.status, { timeout: 5000 }).toBeDefined();
  await expect.poll(() => app.snapshot().writingJobs?.find(j => j.id === taskId)?.status, { timeout: 5000 }).not.toBe("running");
  return app.snapshot().writingJobs!.find(j => j.id === taskId)!;
}
it("recall: continuous generation and chapter checks see distant evidence and retain its original revision", async () => {
  const {app,projectId,calls,dir}=await setup();
  const seed = new Store(join(dir,"works.sqlite"));
  seed.put("chapters",chapter("remote8",8,"铜钥匙由老周保管。",{projectId}));
  for (const n of [117,118,119]) seed.put("chapters",chapter(`r${n}`,n,"雨落。",{projectId}));
  seed.put("chapters",chapter("r120",120,"阿宁再次寻找铜钥匙。",{projectId}));
  seed.close();
  const job=await done(app,await start(app,projectId,"接着写一章"));
  expect(job.status,job.reply).toBe("completed");
  expect(calls.find(c=>c.phase.includes("连续写作·生成"))!.input.context).toContain("铜钥匙由老周保管。");
  expect(calls.filter(c=>c.phase.includes("连续写作·检查")).some(c=>c.input.context.includes("铜钥匙由老周保管。"))).toBe(true);
  expect(job.contextReferences?.[0]).toMatchObject({source:{id:"remote8",revision:1},excerpt:"铜钥匙由老周保管。"});
  expect(job.contextReferenceCall?.phase).toBe("检查");
  expect(job.contextReferenceCall?.ordinal).toBe(121);
  expect(job.contextReferenceCall!.number).toBeLessThan(job.calls);
});
it("recall: filling a missing opening never treats later existing chapters as earlier facts", async () => {
  const {app,projectId,calls,dir}=await setup();
  const seed=new Store(join(dir,"works.sqlite"));
  for(const n of [3,4]) seed.put("chapters",chapter(`later${n}`,n,"国王已死，未来暗号已经公开。".repeat(8),{projectId}));
  seed.put("notes",{...meta,id:"future-knowledge",projectId,type:"knowledge",title:"未来知情记录",body:"王后已经登基，唯一秘密已经公开。",sources:[{kind:"chapter",id:"later3",revision:1}],needsReview:false});
  seed.close();
  await done(app,await start(app,projectId,"写完前五章"));
  const opening=calls.find(c=>c.phase.includes("连续写作·生成")&&c.input.ordinal===1)!;
  expect(opening.input.context).not.toContain("国王已死");
  expect(opening.input.context).not.toContain("未来暗号已经公开");
  expect(opening.input.context).not.toContain("王后已经登基");
});
it("recall: budget refusal leaves no audit reference for a request that was never sent", async () => {
  const {app,projectId,calls,dir}=await setup((phase,_input,res)=>{
    if(phase.includes("连续写作·规划")){reply(res,{plan:"铜钥匙后续目标。".repeat(1000),majorChange:false,reason:""});return true;}
  });
  const seed=new Store(join(dir,"works.sqlite"));
  seed.put("chapters",chapter("old8",8,"铜钥匙由老周保管。",{projectId}));
  for(const n of [117,118,119,120]) seed.put("chapters",chapter(`r${n}`,n,"雨落。",{projectId}));
  seed.close();
  const job=await done(app,await start(app,projectId,"接着写一章",8000));
  expect(job.status).toBe("paused");
  expect(calls).toHaveLength(1);
  expect(calls[0].phase).toContain("连续写作·规划");
  expect(job.contextReferences ?? []).toEqual([]);
});
it("story-state: captures optional changes without extra calls and exposes checked references after completion",async()=>{
  const prose="铜钥匙在老周手中。"+"雨落。".repeat(36);
  const states=[{kind:"item",subject:"铜钥匙",attribute:"持有人",value:"老周",statement:"fact",storyTime:"",quote:"铜钥匙在老周手中。"}];
  const {app,projectId,calls}=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")){reply(res,{title:`第${input.ordinal}章`,content:prose,majorChange:false,reason:"",states:input.ordinal===1?states:[]});return true;}
  });
  const job=await done(app,await start(app,projectId,"写完前二章"));
  expect(job.status,job.reply).toBe("completed");expect(calls).toHaveLength(6);
  expect(app.snapshot().storyRecords).toHaveLength(1);expect(app.snapshot().storyRecords![0].status).toBe("candidate");
  expect(calls.find(c=>c.phase.includes("连续写作·生成")&&c.input.ordinal===2)!.input.context).toContain("本批临时状态");
  expect(app.storyWorkspace({projectId}).current[0]).toMatchObject({value:"老周",automatic:true});
});
it("story-state: invalid optional evidence warns but keeps valid generated prose",async()=>{
  const {app,projectId}=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")){reply(res,{title:`第${input.ordinal}章`,content:"雨落在窗前。".repeat(20),majorChange:false,reason:"",states:[{kind:"item",subject:"铜钥匙",attribute:"持有人",value:"老周",statement:"fact",storyTime:"",quote:"不存在的原文。"}]});return true;}
  });
  const job=await done(app,await start(app,projectId,"写完前一章"));expect(job.status,job.reply).toBe("completed");expect(app.snapshot().chapters[0].content.length).toBe(120);expect(app.snapshot().storyRecords).toEqual([]);expect(job.warnings.length).toBeGreaterThan(0);
});
it("fulfils a five-chapter goal with separate writes, chapter checks and a final review", async () => {
  const { app, projectId, calls } = await setup();
  const job = await done(app, await start(app, projectId));
  expect(job.status, job.reply).toBe("completed");
  expect(app.snapshot().chapters.map(c => c.ordinal)).toEqual([1, 2, 3, 4, 5]);
  expect(app.snapshot().chapters.every(c => c.content.length === 120)).toBe(true);
  expect(calls.filter(c => c.phase.includes("连续写作·生成")).map(c => c.input.ordinal)).toEqual([1, 2, 3, 4, 5]);
  expect(calls.filter(c => c.phase.includes("连续写作·检查"))).toHaveLength(5);
  expect(calls.some(c => c.phase.includes("连续写作·跨章复核"))).toBe(true);
  expect(job.usage?.totalTokens).toBe(calls.length * 30);
});
it("fills missing chapters without rewriting existing prose", async () => {
  const { app, projectId, calls } = await setup();
  for (const ordinal of [1, 2]) {
    const ch = id(await app.dispatch({ type: "chapter.create", projectId, ordinal, title: `原稿${ordinal}` }));
    id(await app.dispatch({ type: "chapter.save", id: ch, revision: 1, content: "作者的原稿。".repeat(20) }));
  }
  const before = app.snapshot().chapters.map(c => ({ ...c }));
  const job = await done(app, await start(app, projectId, "帮我把前五章写完"));
  expect(job.status).toBe("completed");
  expect(calls.filter(c => c.phase.includes("连续写作·生成")).map(c => c.input.ordinal)).toEqual([3, 4, 5]);
  expect(app.snapshot().chapters.slice(0, 2).map(c => [c.content, c.revision])).toEqual(before.map(c => [c.content, c.revision]));
});
it("pauses before a call that exceeds the common budget", async () => {
  const { app, projectId, calls } = await setup();
  const job = await done(app, await start(app, projectId, "写完前五章", 1));
  expect(job.status).toBe("paused");
  expect(job.reply).toContain("预算");
  expect(calls).toHaveLength(0);
});
it("resumes after a budget increase without resetting usage or duplicating saved chapters", async () => {
  const { app, projectId, calls } = await setup();
  const taskId = await start(app, projectId, "写完前五章", 1);
  await done(app, taskId);
  id(await app.dispatch({ type: "writing.resume", id: taskId, tokenBudget: 100000 } as Command));
  const job = await done(app, taskId);
  expect(job.status).toBe("completed");
  expect(job.calls).toBe(calls.length);
  expect(new Set(app.snapshot().chapters.map(c => c.ordinal)).size).toBe(5);
});
it("pauses unfinished length after bounded revisions without pretending it is a creative decision", async () => {
  const { app, projectId, calls } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成") || phase.includes("连续写作·修订")) { reply(res, { title: `第${input.ordinal}章`, content: "太短的稿子。", majorChange: false, reason: "" }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前二章"));
  expect(job.status).toBe("paused");
  expect(job.chapters.map(c => c.revisionRounds)).toEqual([2, 2]);
  expect(calls.filter(c => c.phase.includes("连续写作·修订"))).toHaveLength(4);
  expect(job.error).toContain("篇幅");
  expect(job.issues.some(i => i.category === "length")).toBe(true);
  expect(app.snapshot().chapters).toHaveLength(2);
});
it("stops a major creative change before writing any chapter", async () => {
  const { app, projectId } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·规划")) { reply(res, { plan: "", majorChange: true, reason: "需要改变已确认的结局" }); return true; }
  });
  const job = await done(app, await start(app, projectId));
  expect(job.status).toBe("awaiting-author");
  expect(job.reply).toContain("结局");
  expect(app.snapshot().chapters).toHaveLength(0);
});
it("cancellation aborts a pending response and preserves already saved chapters", async () => {
  let blocked = false;
  const { app, projectId } = await setup((phase, input) => {
    if (phase.includes("连续写作·生成") && input.ordinal === 2) { blocked = true; return true; }
  });
  const taskId = await start(app, projectId);
  await expect.poll(() => blocked).toBe(true);
  id(await app.dispatch({ type: "writing.cancel", id: taskId } as Command));
  expect((await done(app, taskId)).status).toBe("cancelled");
  expect(app.snapshot().chapters.map(c => c.ordinal)).toEqual([1]);
});
it("restart preserves progress and only writes remaining chapters when resumed", async () => {
  let blocked = false, block = true;
  const fixture = await setup((phase, input) => {
    if (block && phase.includes("连续写作·生成") && input.ordinal === 3) { blocked = true; return true; }
  });
  const taskId = await start(fixture.app, fixture.projectId);
  await expect.poll(() => blocked).toBe(true);
  const app = await fixture.restart();
  expect(app.snapshot().writingJobs![0].status).toBe("interrupted");
  const callsBefore = fixture.calls.length, spent = app.snapshot().writingJobs![0].budgetUsed;
  expect(app.snapshot().chapters.map(c => c.ordinal)).toEqual([1, 2]);
  block = false;
  id(await app.dispatch({ type: "writing.resume", id: taskId } as Command));
  expect((await done(app, taskId)).status).toBe("completed");
  expect(fixture.calls.slice(callsBefore).filter(c => c.phase.includes("连续写作·生成")).map(c => c.input.ordinal)).toEqual([3, 4, 5]);
  expect(app.snapshot().writingJobs![0].budgetUsed).toBeGreaterThan(spent);
});

function lastChapter(input: any) {
  const sources = [...input.context.matchAll(/\[chapter:([^@\]]+)@(\d+)\]/g)];
  const source = sources.at(-1)!;
  return { kind: "chapter", id: source[1], revision: Number(source[2]) };
}
it("blocking contradictions stop after two revisions and do not create downstream chapters", async () => {
  const { app, projectId, calls } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成") || phase.includes("连续写作·修订")) { reply(res, { title: "矛盾", content: "今年十八岁。去年三十岁。".repeat(10) }); return true; }
    if (phase.includes("连续写作·检查")) {
      const source = lastChapter(input);
      reply(res, { issues: [{ category: "timeline", impact: "blocking", reason: "同一角色年龄冲突", evidence: [{ quote: "今年十八岁。", source }, { quote: "去年三十岁。", source }] }], majorChange: false, reason: "" }); return true;
    }
  });
  const job = await done(app, await start(app, projectId));
  expect(job.status).toBe("awaiting-author");
  expect(job.chapters[0].revisionRounds).toBe(2);
  expect(calls.filter(c => c.phase.includes("连续写作·修订"))).toHaveLength(2);
  expect(app.snapshot().chapters.map(c => c.ordinal)).toEqual([1]);
});
it("repairs a uniquely located factual sentence once after two whole-chapter revisions", async () => {
  const bad = "今年十八岁。去年三十岁。" + "雨落在窗前。".repeat(18);
  let fixed = false, patches = 0;
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成") || phase.includes("连续写作·修订")) { reply(res,{title:"雨夜",content:bad});return true; }
    if (phase.includes("连续写作·定点修正")) { fixed=true;patches++;reply(res,{type:"json_object",edits:[{quote:"去年三十岁。",replacement:"去年十七岁。",reason:"保持相邻年份年龄一致"}],majorChange:false,reason:""});return true; }
    if (!fixed && phase.includes("连续写作·检查")) { const source=lastChapter(input);reply(res,{issues:[{category:"timeline",impact:"blocking",reason:"人物年龄冲突",evidence:[{quote:"今年十八岁。",source},{quote:"去年三十岁。",source}]}],majorChange:false,reason:""});return true; }
  });
  const job=await done(app,await start(app,projectId,"写完前一章"));
  expect(job.status,job.reply).toBe("completed");
  expect(patches).toBe(1);
  expect(app.snapshot().chapters[0].content).toBe(bad.replace("去年三十岁。","去年十七岁。"));
  expect(job.chapters[0].revisionRounds).toBe(2);
});
it.each(["edit", "cancel"])("protects an in-flight targeted repair from %s", async (action) => {
  const bad="今年十八岁。去年三十岁。"+"雨落在窗前。".repeat(18);
  let release: (()=>void)|undefined;
  const {app,projectId}=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")||phase.includes("连续写作·修订")){reply(res,{title:"雨夜",content:bad});return true;}
    if(phase.includes("连续写作·定点修正")){release=()=>reply(res,{edits:[{quote:"去年三十岁。",replacement:"去年十七岁。"}],majorChange:false,reason:""});return true;}
    if(phase.includes("连续写作·检查")){const source=lastChapter(input);reply(res,{issues:[{category:"timeline",impact:"blocking",reason:"年龄冲突",evidence:[{quote:"今年十八岁。",source},{quote:"去年三十岁。",source}]}],majorChange:false,reason:""});return true;}
  });
  const jobId=await start(app,projectId,"写完前一章");
  await expect.poll(()=>!!release).toBe(true);
  const chapter=app.snapshot().chapters[0];
  if(action==="edit")id(await app.dispatch({type:"chapter.save",id:chapter.id,revision:chapter.revision,content:"作者刚写的新正文"}));
  else id(await app.dispatch({type:"writing.cancel",id:jobId}));
  release!();
  const job=await done(app,jobId);
  expect(job.status).toBe(action==="edit"?"paused":"cancelled");
  expect(app.snapshot().chapters[0].content).toBe(action==="edit"?"作者刚写的新正文":bad);
  expect(job.chapters[0].targetedRevisionRounds??0).toBe(0);
});
it.each(["unrelated", "whole", "decision"])("does not apply an invalid targeted %s change", async (kind) => {
  const bad="今年十八岁。去年三十岁。这句完全无关。"+"雨落在窗前。".repeat(17);
  const {app,projectId}=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")||phase.includes("连续写作·修订")){reply(res,{title:"雨夜",content:bad});return true;}
    if(phase.includes("连续写作·定点修正")){reply(res,{edits:[{quote:kind==="whole"?bad:"这句完全无关。",replacement:"不得应用"}],majorChange:kind==="decision",reason:kind==="decision"?"需要修改主角身份":""});return true;}
    if(phase.includes("连续写作·检查")){const source=lastChapter(input);reply(res,{issues:[{category:"timeline",impact:"blocking",reason:"年龄冲突",evidence:[{quote:"今年十八岁。",source},{quote:"去年三十岁。",source}]}],majorChange:false,reason:""});return true;}
  });
  const job=await done(app,await start(app,projectId,"写完前一章"));
  expect(job.status).toBe("awaiting-author");
  expect(app.snapshot().chapters[0].content).toBe(bad);
});
it("invalidates a cross-chapter targeted repair when another evidence chapter changes", async () => {
  let release:(()=>void)|undefined, service:AppServices;
  const first="主角今年十八岁。"+"雨落在窗前。".repeat(18), second="同一天主角三十岁。"+"风吹过庭院。".repeat(18);
  const {app,projectId}=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")||phase.includes("连续写作·修订")){reply(res,{title:"雨夜",content:input.ordinal===1?first:second});return true;}
    if(phase.includes("连续写作·跨章复核")){
      const chapters=service.snapshot().chapters, a=chapters.find(c=>c.ordinal===1)!,b=chapters.find(c=>c.ordinal===2)!;
      reply(res,{issues:[{category:"timeline",impact:"blocking",reason:"同日年龄冲突",evidence:[{quote:"同一天主角三十岁。",source:{kind:"chapter",id:b.id,revision:b.revision}},{quote:"主角今年十八岁。",source:{kind:"chapter",id:a.id,revision:a.revision}}]}],majorChange:false,reason:""});return true;
    }
    if(phase.includes("连续写作·定点修正")){release=()=>reply(res,{edits:[{quote:"主角今年十八岁。",replacement:"主角今年三十岁。"}],majorChange:false,reason:""});return true;}
  });
  service=app;
  const jobId=await start(app,projectId,"写完前二章");
  await expect.poll(()=>!!release).toBe(true);
  const other=app.snapshot().chapters.find(c=>c.ordinal===2)!;
  id(await app.dispatch({type:"chapter.save",id:other.id,revision:other.revision,content:"作者重新明确了时间和年龄。"}));
  release!();
  const job=await done(app,jobId);
  expect(job.status).toBe("paused");
  expect(app.snapshot().chapters.find(c=>c.ordinal===1)!.content).toBe(first);
});
it("local style advice completes without rewriting prose or requiring author action", async () => {
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·检查") || phase.includes("连续写作·跨章复核")) {
      const source = lastChapter(input);
      reply(res, { issues: [{ category: "style", impact: "local", reason: "同一句话反复出现，行文单调", evidence: [{ quote: "雨落在窗前。", source }] }], majorChange: false, reason: "" }); return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前二章"));
  expect(job.status).toBe("completed");
  expect(job.chapters.map(c => c.revisionRounds)).toEqual([0, 0]);
  expect(app.snapshot().chapters).toHaveLength(2);
});
it("existing prose needing completion is proposed for review and remains unchanged", async () => {
  const { app, projectId } = await setup();
  const ch = id(await app.dispatch({ type: "chapter.create", projectId, ordinal: 1, title: "原来的标题" }));
  id(await app.dispatch({ type: "chapter.save", id: ch, revision: 1, content: "作者只写了一个开头。" }));
  const job = await done(app, await start(app, projectId, "写完前二章"));
  expect(job.status, job.reply).toBe("awaiting-author");
  expect(app.chapter(ch).content).toBe("作者只写了一个开头。");
  expect(job.revisionJobIds).toHaveLength(1);
  const proposal = app.revisionJob(job.revisionJobIds[0]);
  expect(proposal.scope).toBe("chapters");
  expect(proposal.candidates[0].status).toBe("pending");
  id(await app.dispatch({ type: "revision.accept", id: proposal.id, chapterIds: [ch] }));
  expect(app.chapter(ch).content).toBe("雨落在窗前。".repeat(20));
  id(await app.dispatch({ type: "writing.resume", id: job.id }));
  expect((await done(app, job.id)).status).toBe("completed");
});
it("does not overwrite a manual edit made while a revision is in flight", async () => {
  let blocked: ServerResponse | undefined;
  const { app, projectId } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·生成")) { reply(res, { title: "短章", content: "短文。" }); return true; }
    if (phase.includes("连续写作·修订")) { blocked = res; return true; }
  });
  const taskId = await start(app, projectId);
  await expect.poll(() => !!blocked).toBe(true);
  const ch = app.snapshot().chapters[0];
  id(await app.dispatch({ type: "chapter.save", id: ch.id, revision: ch.revision, content: "作者亲自改好的版本。" }));
  reply(blocked!, { title: "迟到的版本", content: "雨落在窗前。".repeat(20) });
  const job = await done(app, taskId);
  expect(job.status).toBe("paused");
  expect(app.chapter(ch.id).content).toBe("作者亲自改好的版本。");
});
it("unknown provider usage remains reserved and disclosed", async () => {
  const { app, projectId } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·规划")) { reply(res, { plan: "逐章计划", majorChange: false, reason: "" }, null); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status).toBe("completed");
  expect(job.usage?.totalTokens).toBeNull();
  expect(job.usage?.estimated).toBe(true);
  expect(job.budgetUsed).toBeGreaterThan(job.calls * 30);
  expect(job.warnings.join(" ")).toContain("用量未知");
});
it("a user edit before the first check is protected on resume as existing prose", async () => {
  let held: ServerResponse | undefined, hold = true;
  const { app, projectId } = await setup((phase, _input, res) => {
    if (hold && phase.includes("连续写作·检查")) { held = res; return true; }
  });
  const taskId = await start(app, projectId, "写完前一章");
  await expect.poll(() => !!held).toBe(true);
  id(await app.dispatch({ type: "writing.pause", id: taskId }));
  const ch = app.snapshot().chapters[0];
  id(await app.dispatch({ type: "chapter.save", id: ch.id, revision: ch.revision, content: "作者的新开头。" }));
  hold = false;
  id(await app.dispatch({ type: "writing.resume", id: taskId }));
  const job = await done(app, taskId);
  expect(job.status).toBe("awaiting-author");
  expect(app.chapter(ch.id).content).toBe("作者的新开头。");
  expect(job.revisionJobIds).toHaveLength(1);
});
it("candidate acceptance rejects changed story notes", async () => {
  const { app, projectId } = await setup();
  const ch = id(await app.dispatch({ type: "chapter.create", projectId, ordinal: 1, title: "原稿" }));
  id(await app.dispatch({ type: "chapter.save", id: ch, revision: 1, content: "原稿开头。" }));
  const note = id(await app.dispatch({ type: "note.save", projectId, noteType: "character", title: "主角", body: "主角是侦探", sources: [] }));
  const job = await done(app, await start(app, projectId, "写完前一章"));
  id(await app.dispatch({ type: "note.save", id: note, revision: app.snapshot().notes.find(n => n.id === note)!.revision, projectId, noteType: "character", title: "主角", body: "主角是医生，从未当过侦探", sources: [] }));
  const accepted = await app.dispatch({ type: "revision.accept", id: job.revisionJobIds[0], chapterIds: [ch] });
  expect(accepted.ok).toBe(false);
  expect(app.chapter(ch).content).toBe("原稿开头。");
});
it("resumes the interrupted chapter check window without repurchasing successful windows", async () => {
  let checking = 0, hold = true, blocked = false;
  const contexts: string[] = [];
  const { app, projectId } = await setup((phase, input) => {
    if (phase.includes("连续写作·检查")) {
      checking++; contexts.push(input.context);
      if (hold && checking === 2) { blocked = true; return true; }
    }
  }, { maxContextChars: 1200 });
  const p = app.snapshot().projects[0];
  id(await app.dispatch({ type: "project.update", id: projectId, revision: p.revision, patch: { chapterWords: 1800 } }));
  const ch = id(await app.dispatch({ type: "chapter.create", projectId, ordinal: 1, title: "长章" }));
  id(await app.dispatch({ type: "chapter.save", id: ch, revision: 1, content: "雨落在窗前。".repeat(300) }));
  const taskId = await start(app, projectId, "写完前一章");
  await expect.poll(() => blocked).toBe(true);
  id(await app.dispatch({ type: "writing.pause", id: taskId }));
  hold = false;
  id(await app.dispatch({ type: "writing.resume", id: taskId }));
  expect((await done(app, taskId)).status).toBe("completed");
  expect(contexts[2]).toBe(contexts[1]);
  expect(contexts[2]).not.toBe(contexts[0]);
});
it("rejecting two blocking revisions never grants permission to write downstream chapters", async () => {
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·检查")) {
      const source = lastChapter(input);
      reply(res, { issues: [{ category: "timeline", impact: "blocking", reason: "主角年龄矛盾", evidence: [{ quote: "今年十八岁。", source }, { quote: "去年三十岁。", source }] }], majorChange: false, reason: "" }); return true;
    }
  });
  const ch = id(await app.dispatch({ type: "chapter.create", projectId, ordinal: 1, title: "原稿" }));
  id(await app.dispatch({ type: "chapter.save", id: ch, revision: 1, content: "今年十八岁。去年三十岁。".repeat(10) }));
  const taskId = await start(app, projectId, "写完前二章");
  let job = await done(app, taskId);
  for (let i = 0; i < 2; i++) {
    id(await app.dispatch({ type: "revision.reject", id: job.revisionJobIds.at(-1)!, chapterIds: [ch] }));
    id(await app.dispatch({ type: "writing.resume", id: taskId }));
    job = await done(app, taskId);
  }
  expect(job.status).toBe("awaiting-author");
  expect(app.snapshot().chapters.map(c => c.ordinal)).toEqual([1]);
});
it("repairs an invalid review once without erasing its original finding", async () => {
  let repairs = 0, invalid = true;
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·检查整理")) {
      repairs++;
      const source = lastChapter(input);
      reply(res, { type: "json_object", issues: [{ category: "style", impact: "local", reason: "重复句式", evidence: [{ quote: "雨落在窗前。", source }] }], majorChange: false, reason: "" }); return true;
    }
    if (invalid && phase.includes("连续写作·检查")) {
      invalid = false;
      const source = { ...lastChapter(input), revision: 999 };
      reply(res, { type: "json_object", issues: [{ category: "style", impact: "local", reason: "重复句式", evidence: [{ quote: "雨落在窗前。", source }] }], majorChange: false, reason: "" }); return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status, job.reply).toBe("completed");
  expect(repairs).toBe(1);
  expect(job.chapters[0].revisionRounds).toBe(0);
});
it("invalid review repair cannot clear unresolved findings to manufacture success", async () => {
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·检查整理")) { reply(res, { issues: [], majorChange: false, reason: "" }); return true; }
    if (phase.includes("连续写作·检查")) { reply(res, { issues: [{ category: "style", impact: "local", reason: "重复句式", evidence: [{ quote: "不存在的原文", source: lastChapter(input) }] }], majorChange: false, reason: "" }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status).toBe("failed");
  expect(job.reply).toContain("清空");
});
it("an invalid major-change flag cannot be repaired into a successful empty review", async () => {
  const { app, projectId } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·检查整理")) { reply(res, { issues: [], majorChange: false, reason: "" }); return true; }
    if (phase.includes("连续写作·检查")) { reply(res, { issues: [], majorChange: "true", reason: "必须改变主角身份" }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status).toBe("failed");
});
it("can restore omitted review controls without deleting an existing finding", async () => {
  let omitted = true;
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·检查整理")) { reply(res, { issues: [{ category: "style", impact: "local", reason: "句式重复", evidence: [{ quote: "雨落在窗前。", source: lastChapter(input) }] }], majorChange: false, reason: "" }); return true; }
    if (omitted && phase.includes("连续写作·检查")) { omitted = false; reply(res, { issues: [{ category: "style", impact: "local", reason: "句式重复", evidence: [{ quote: "雨落在窗前。", source: lastChapter(input) }] }] }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status, job.reply).toBe("completed");
  expect(job.chapters[0].revisionRounds).toBe(0);
});
it("unwraps the provider json_object envelope without rewriting its complete draft", async () => {
  const content = "雨落在窗前。".repeat(20);
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成")) { reply(res, { type: "json_object", content: JSON.stringify({ title: `第${input.ordinal}章`, content }) }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status, job.reply).toBe("completed");
  expect(app.snapshot().chapters[0].content).toBe(content);
});
it("retains Chinese quotation marks when a provider unnecessarily escapes them", async () => {
  const content = "他说：“旧钟修好了。”" + "雨落。".repeat(35);
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成")) {
      const raw = JSON.stringify({ type: "json_object", title: `第${input.ordinal}章`, content }).replace("“", "\\“");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
      return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status, job.reply).toBe("completed");
  expect(app.snapshot().chapters[0].content).toBe(content);
});
it("saves complete prose when a balanced optional scene object is malformed, retaining the raw reply", async () => {
  const content = "雨落在窗前。".repeat(20);
  const raw = '{"scenes":[{"title":"场景",{"type":"hint","value":"旁支"}}],"title":"旧钟","content":' + JSON.stringify(content) + ',"majorChange":false,"reason":""}';
  const { app, projectId, calls } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·生成")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({choices:[{message:{content:raw},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status, job.reply).toBe("completed");
  expect(app.snapshot().chapters[0]).toMatchObject({title:"旧钟",content});
  expect(app.snapshot().scenePlans).toEqual([]);
  expect(job.warnings.some(w=>w.includes("场景卡"))).toBe(true);
  expect(job.lastFailedResponse!.rawResponse).toBe(raw);
  expect(calls).toHaveLength(4);
});
it("continues all four 3000-character chapters when the model adds a flat json_object type marker", async () => {
  const content = "雨落在窗前。".repeat(500);
  const { app, projectId, calls } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成")) {
      reply(res, { type: "json_object", title: `第${input.ordinal}章`, content, scenes: [], states: [], majorChange: false, reason: "" });
      return true;
    }
  });
  const p = app.snapshot().projects[0];
  id(await app.dispatch({ type: "project.update", id: projectId, revision: p.revision, patch: { chapterWords: 3000 } }));
  const first = id(await app.dispatch({ type: "chapter.create", projectId, ordinal: 1, title: "作者开篇" }));
  id(await app.dispatch({ type: "chapter.save", id: first, revision: 1, content: "作者已保存的第一章。" }));
  const job = await done(app, await start(app, projectId, "接着写4章，每章大约3000字", 200000));
  expect(job.status, job.reply).toBe("completed");
  expect(job.chapters.map(c => [c.ordinal, c.status])).toEqual([[2, "checked"], [3, "checked"], [4, "checked"], [5, "checked"]]);
  expect(app.snapshot().chapters.filter(c => c.ordinal > 1).map(c => c.content)).toEqual([content, content, content, content]);
  expect(app.snapshot().chapters.find(c => c.id === first)!.content).toBe("作者已保存的第一章。");
  expect(calls.filter(c => c.phase.includes("连续写作·生成")).map(c => c.input.ordinal)).toEqual([2, 3, 4, 5]);
  expect(job.calls).toBe(10);
});
it("preserves an unrecognized writing reply across restart without exposing its body in polling", async () => {
  const draft = "不能丢掉的生成原文。";
  const f = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成") && input.ordinal === 2) {
      reply(res, { title: "第二章", content: draft, unsupportedDecision: true });
      return true;
    }
  });
  const taskId = await start(f.app, f.projectId, "写完前四章");
  const job = await done(f.app, taskId);
  expect(job.status).toBe("failed");
  expect(job.chapters.map(c => c.status)).toEqual(["checked", "pending", "pending", "pending"]);
  expect(JSON.parse(job.lastFailedResponse!.rawResponse)).toMatchObject({ content: draft, unsupportedDecision: true });
  expect(job.lastFailedResponse!).toMatchObject({ phase: "writing", ordinal: 2, truncated: false });
  expect(JSON.stringify(f.app.workspaceSnapshot(f.projectId))).not.toContain(draft);
  const app = await f.restart();
  expect(JSON.parse(app.snapshot().writingJobs![0].lastFailedResponse!.rawResponse).content).toBe(draft);
  expect(app.snapshot().chapters).toHaveLength(1);
});
it("preserves a major creative decision in a flat json_object result", async () => {
  const { app, projectId } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·生成")) {
      reply(res, { type: "json_object", title: "待确认", content: "不能擅自应用的改写", majorChange: true, reason: "需要改变已确认的结局" });
      return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前四章"));
  expect(job.status).toBe("awaiting-author");
  expect(job.reply).toBe("需要改变已确认的结局");
  expect(app.snapshot().chapters).toHaveLength(0);
});
it.each(["生成", "检查"])("redacts the configured key from failed %s provider output before persisting diagnostics", async (failedPhase) => {
  const key = `fixture-private-${failedPhase === "生成" ? "writing" : "checking"}-key-do-not-export`;
  const { app, projectId } = await setup((phase, _input, res) => {
    if (phase.includes(`连续写作·${failedPhase}`)) {
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({choices:[{delta:{content:`片段 ${key}`},finish_reason:"content_filter"}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
      return true;
    }
  }, { credentials: { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Uint8Array) => Buffer.from(value).toString() } });
  const profile = app.snapshot().profiles[0];
  id(await app.dispatch({ type: "profile.save", id: profile.id, revision: profile.revision, name: profile.name, model: profile.model, baseUrl: profile.baseUrl, purpose: profile.purpose, apiKey: failedPhase === "生成" ? key : "fixture-writing-key" }));
  if (failedPhase === "检查") id(await app.dispatch({ type: "profile.save", name: "checking", model: profile.model, baseUrl: profile.baseUrl, purpose: "checking", apiKey: key }));
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status).toBe("failed");
  expect(job.lastFailedResponse?.rawResponse).toBe("片段 [已隐藏]");
  expect(JSON.stringify(app.snapshot().writingJobs)).not.toContain(key);
  expect(app.snapshot().chapters).toHaveLength(failedPhase === "检查" ? 1 : 0);
});
it.each(["chapter", "json", null])("does not ignore an unknown type marker %j", async (type) => {
  const { app, projectId, calls } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·生成")) {
      reply(res, { type, title: "待确认", content: "不能静默接受" });
      return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前四章"));
  expect(job.status).toBe("failed");
  expect(app.snapshot().chapters).toHaveLength(0);
  expect(calls).toHaveLength(2);
});
it("does not unwrap envelopes that carry additional decision fields", async () => {
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成")) { reply(res, { type: "json_object", content: JSON.stringify({ title: `第${input.ordinal}章`, content: "雨落在窗前。".repeat(20) }), majorChange: true }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status).toBe("failed");
  expect(app.snapshot().chapters).toHaveLength(0);
});
it("a rejected check envelope cannot enter repair and lose its nested decision", async () => {
  const { app, projectId } = await setup((phase, _input, res) => {
    if (phase.includes("连续写作·检查整理")) { reply(res, { issues: [], majorChange: false, reason: "" }); return true; }
    if (phase.includes("连续写作·检查")) { reply(res, { type: "json_object", content: JSON.stringify({ issues: [], majorChange: true, reason: "需要改变已确认的结局" }), issues: [] }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status).toBe("failed");
});
it("scenes: same generation response saves two scene cards without an extra request",async()=>{
  const cards=Array.from({length:2},(_,i)=>({title:`雨夜${i}`,pov:"阿宁",goal:"查信",obstacle:"锁门",turn:"解暗号",reveal:"旧城",words:60,hook:"脚步",quote:"雨落在窗前。"}));
  const f=await setup((phase,input,res)=>{if(phase.includes("连续写作·生成")){reply(res,{title:"雨夜",content:"雨落在窗前。".repeat(20),majorChange:false,reason:"",scenes:cards});return true;}});
  const j=await done(f.app,await start(f.app,f.projectId,"写完前一章"));expect(j.status,j.reply).toBe("completed");expect(f.calls).toHaveLength(4);expect(f.app.snapshot().scenePlans).toHaveLength(1);expect(f.app.snapshot().scenePlans![0].cards).toHaveLength(2);
});
it("scenes: malformed optional cards warn while preserving complete generated prose",async()=>{
  const f=await setup((phase,_input,res)=>{if(phase.includes("连续写作·生成")){reply(res,{title:"雨夜",content:"雨落在窗前。".repeat(20),majorChange:false,reason:"",scenes:[{title:"坏卡"}]});return true;}});
  const j=await done(f.app,await start(f.app,f.projectId,"写完前一章"));expect(j.status,j.reply).toBe("completed");expect(f.app.snapshot().chapters[0].content.length).toBe(120);expect(f.app.snapshot().scenePlans).toEqual([]);expect(j.warnings.join(" ")).toContain("场景");
});
it("scenes: an author plan reaches the generation input and cannot be replaced by returned cards",async()=>{
  const f=await setup((phase,input,res)=>{if(phase.includes("连续写作·生成")){reply(res,{title:"雨夜",content:"雨落在窗前。".repeat(20),majorChange:false,reason:"",scenes:Array.from({length:2},(_,i)=>({title:`模型卡${i}`,pov:"老周",goal:"模型新目标",obstacle:"雨",turn:"门开",reveal:"信",words:60,hook:"下一章"}))});return true;}});
  const ch=id(await f.app.dispatch({type:"chapter.create",projectId:f.projectId,ordinal:1,title:"开篇"}));
  id(await f.app.dispatch({type:"scene.save",projectId:f.projectId,chapterId:ch,targetWords:120,cards:Array.from({length:2},(_,i)=>({title:`作者卡${i}`,pov:"阿宁",goal:"作者保留目标",obstacle:"锁门",turn:"解锁",reveal:"信",words:60,hook:"脚步"}))}));
  const j=await done(f.app,await start(f.app,f.projectId,"写完前一章"));expect(j.status,j.reply).toBe("completed");expect(f.calls.find(c=>c.phase.includes("连续写作·生成"))!.input.scenePlan.cards[0].goal).toBe("作者保留目标");expect(f.app.snapshot().scenePlans![0].cards[0].goal).toBe("作者保留目标");
});

it("scenes: the author per-chapter allocation controls generation and length verification",async()=>{const f=await setup((phase,input,res)=>{if(phase.includes("连续写作·生成")){reply(res,{title:"雨夜",content:"雨落在窗前。".repeat(100).slice(0,input.chapterWords),majorChange:false,reason:""});return true;}});const ch=id(await f.app.dispatch({type:"chapter.create",projectId:f.projectId,ordinal:1,title:"雨夜"}));id(await f.app.dispatch({type:"scene.save",projectId:f.projectId,chapterId:ch,targetWords:200,cards:Array.from({length:2},(_,i)=>({title:`场景${i}`,pov:"阿宁",goal:"找信",obstacle:"门锁",turn:"发现暗号",reveal:"旧城",words:100,hook:"脚步"}))}));const j=await done(f.app,await start(f.app,f.projectId,"写完前一章"));const input=f.calls.find(c=>c.phase.includes("连续写作·生成"))!.input;expect(input.chapterWords).toBe(200);expect(input.wordLimit).toMatchObject({min:180,max:220});expect(j.chapters[0].revisionRounds).toBe(0);expect(f.app.snapshot().chapters[0].content.length).toBe(200);});
it("scenes: a newly added author plan blocks a generation that started without one",async()=>{let release:(()=>void)|undefined;const f=await setup((phase,_input,res)=>{if(phase.includes("连续写作·生成")){release=()=>reply(res,{title:"旧方向",content:"雨落在窗前。".repeat(20),majorChange:false,reason:""});return true;}});const ch=id(await f.app.dispatch({type:"chapter.create",projectId:f.projectId,ordinal:1,title:"开篇"}));const jid=await start(f.app,f.projectId,"写完前一章");await expect.poll(()=>!!release).toBe(true);id(await f.app.dispatch({type:"scene.save",projectId:f.projectId,chapterId:ch,targetWords:120,cards:Array.from({length:2},(_,i)=>({title:`新方向${i}`,pov:"阿宁",goal:"作者刚明确的新方向",obstacle:"锁门",turn:"暗号",reveal:"旧城",words:60,hook:"脚步"}))}));release!();const j=await done(f.app,jid);expect(j.status,j.reply).toBe("paused");expect(f.app.snapshot().chapters[0].content).toBe("");expect(f.app.snapshot().scenePlans![0].cards[0].goal).toBe("作者刚明确的新方向");});
it("unknown computed output metadata stays rejected rather than bypassing the writing contract", async () => {
  const {app,projectId}=await setup((phase,_input,res)=>{
    if(phase.includes("连续写作·生成")){reply(res,{type:"json_object",title:"雨夜",content:"雨落在窗前。".repeat(20),wordCount:120,scenes:[],states:[]});return true;}
  });
  const job=await done(app,await start(app,projectId,"写完前一章"));
  expect(job.status).toBe("failed");
  expect(job.error).toContain("回复字段不正确");
  expect(app.snapshot().chapters).toHaveLength(0);
  expect(job.lastFailedResponse?.rawResponse).toContain('"wordCount"');
});
it("revision can continue when this task's earlier automatic scene cards became stale", async () => {
  let revisions=0;
  const cards=[{title:"进门",pov:"阿宁",goal:"修钟",obstacle:"找不到工具",turn:"发现抽屉",reveal:"工具在抽屉",words:60,hook:"拿起工具"},{title:"开工",pov:"阿宁",goal:"打开钟壳",obstacle:"螺丝生锈",turn:"找到办法",reveal:"机芯松动",words:60,hook:"开始维修"}];
  const {app,projectId,calls}=await setup((phase,_input,res)=>{
    if(phase.includes("连续写作·生成")){reply(res,{title:"修理铺",content:"雨".repeat(70),scenes:cards,majorChange:false,reason:""});return true;}
    if(phase.includes("连续写作·修订")){revisions++;reply(res,{title:"修理铺",content:"雨".repeat(revisions===1?80:120),majorChange:false,reason:""});return true;}
  });
  const job=await done(app,await start(app,projectId,"写完前一章"));
  expect(job.status,job.error??job.reply).toBe("completed");
  expect(revisions).toBe(2);
  expect(app.snapshot().chapters[0].content).toBe("雨".repeat(120));
  const revisionCalls=calls.filter(c=>c.phase.includes("连续写作·修订"));
  expect(revisionCalls[0].input.scenePlan).toBeDefined();
  expect(revisionCalls[1].input.scenePlan).toBeUndefined();
  expect(job.chapters[0].status).toBe("checked");
});
it("stale author scene plans still require review before an automatic revision", async () => {
  const {app,projectId,calls}=await setup();
  const chapterId=id(await app.dispatch({type:"chapter.create",projectId,ordinal:1,title:"作者原稿"}));
  id(await app.dispatch({type:"chapter.save",id:chapterId,revision:1,content:"雨".repeat(70)}));
  const cards=[{title:"进门",pov:"阿宁",goal:"修钟",obstacle:"找工具",turn:"发现抽屉",reveal:"找到工具",words:60,hook:"开工"},{title:"维修",pov:"阿宁",goal:"打开钟壳",obstacle:"生锈",turn:"想到办法",reveal:"机芯松动",words:60,hook:"继续"}];
  id(await app.dispatch({type:"scene.save",projectId,chapterId,targetWords:120,cards}));
  id(await app.dispatch({type:"chapter.save",id:chapterId,revision:2,content:"作者保留的文字。".repeat(8)}));
  const job=await done(app,await start(app,projectId,"写完前一章"));
  expect(job.status).toBe("paused");
  expect(job.error).toContain("场景依据已改变");
  expect(calls.some(c=>c.phase.includes("连续写作·修订"))).toBe(false);
  expect(app.snapshot().chapters[0].content).toBe("作者保留的文字。".repeat(8));
});
it("resume rechecks stale issue evidence outside the writing goal before revising prose",async()=>{
  const {app,projectId,dir,calls}=await setup();
  const first=id(await app.dispatch({type:"chapter.create",projectId,ordinal:1,title:"前章"}));
  id(await app.dispatch({type:"chapter.save",id:first,revision:1,content:"旧事实。".repeat(30)}));
  const job=await done(app,await start(app,projectId,"接着写一章"));
  const target=app.snapshot().chapters.find(c=>c.ordinal===2)!;
  const seed=new Store(join(dir,"works.sqlite"));
  seed.put("writingJobs",{...job,status:"paused",phase:"revising",cursor:0,issues:[{category:"timeline",impact:"blocking",reason:"上次检查发现的衔接问题。",chapterId:target.id,evidence:[{quote:"旧事实。",source:{kind:"chapter",id:first,revision:2}},{quote:"雨落在窗前。",source:{kind:"chapter",id:target.id,revision:target.revision}}]}]});seed.close();
  id(await app.dispatch({type:"chapter.confirm",id:first,revision:2}));
  const callCount=calls.length;
  id(await app.dispatch({type:"writing.resume",id:job.id}));
  const resumed=await done(app,job.id);
  expect(resumed.status,resumed.reply).toBe("completed");
  const later=calls.slice(callCount);
  expect(later[0].phase).toContain("连续写作·检查");
  expect(later.some(c=>c.phase.includes("连续写作·修订"))).toBe(false);
  expect(app.snapshot().chapters.find(c=>c.id===target.id)?.revision).toBe(target.revision);
  expect(app.snapshot().chapters.find(c=>c.id===first)?.content).toBe("旧事实。".repeat(30));
});

it("automatically budgets a writing request and snapshots its requested word target", async () => {
  const { app, projectId, calls } = await setup();
  const taskId = id(await app.dispatch({type:"conversation.send",projectId,text:"接着写2章，每章大约120字"}));
  const job = await done(app, taskId);
  expect(job.status,job.reply).toBe("completed");
  expect(job).toMatchObject({budgetMode:"auto",targetWords:120});
  expect(job.tokenBudget).toBeGreaterThan(job.budgetUsed);
  expect(calls.find(c=>c.phase.includes("连续写作·生成"))!.input.wordLimit).toMatchObject({min:108,max:132});
});

it("repairs a chapter outside ten percent even when it was within the old twenty percent", async () => {
  const {app,projectId,calls}=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")){reply(res,{title:"雨城",content:"雨".repeat(100),majorChange:false,reason:""});return true;}
  });
  const job=await done(app,await start(app,projectId,"接着写1章"));
  expect(job.status,job.reply).toBe("completed");
  expect(job.chapters[0].revisionRounds).toBe(1);
  expect(app.snapshot().chapters[0].content.length).toBe(120);
  expect(calls.filter(c=>c.phase.includes("连续写作·修订"))).toHaveLength(1);
});

it("a larger automatic writing goal receives more allowance without a token input", async () => {
  const f=await setup();
  const first=await done(f.app,id(await f.app.dispatch({type:"conversation.send",projectId:f.projectId,text:"接着写1章"})));
  const second=await done(f.app,id(await f.app.dispatch({type:"conversation.send",projectId:f.projectId,text:"接着写5章"})));
  expect(second.status,second.reply).toBe("completed");
  expect(second.tokenBudget).toBeGreaterThan(first.tokenBudget);
  expect(second.budgetMode).toBe("auto");
});

it("uses automatically maintained facts in the next batch without calling them author-confirmed",async()=>{
  const prose="铜钥匙在老周手中。"+"雨落。".repeat(36);
  const f=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")){reply(res,{title:`第${input.ordinal}章`,content:prose,majorChange:false,reason:"",states:input.ordinal===1?[{kind:"item",subject:"铜钥匙",attribute:"持有人",value:"老周",statement:"fact",storyTime:"",quote:"铜钥匙在老周手中。"}]:[]});return true;}
  });
  const first=await done(f.app,await start(f.app,f.projectId,"接着写1章"));
  expect(first.status,first.reply).toBe("completed");
  expect(f.app.storyWorkspace({projectId:f.projectId}).current[0]).toMatchObject({value:"老周",automatic:true,status:"candidate"});
  await done(f.app,await start(f.app,f.projectId,"接着写1章"));
  const generation=f.calls.find(c=>c.phase.includes("连续写作·生成")&&c.input.ordinal===2)!;
  expect(generation.input.context).toContain("正文自动整理");
  const ch=f.app.snapshot().chapters[0];
  id(await f.app.dispatch({type:"chapter.save",id:ch.id,revision:ch.revision,content:prose+"作者修改。"}));
  expect(f.app.storyWorkspace({projectId:f.projectId}).current).toEqual([]);
  expect(f.app.storyWorkspace({projectId:f.projectId}).blockedCount).toBeGreaterThan(0);
});

it("automatically managed facts honor an author's rejection",async()=>{
  const prose="铜钥匙在老周手中。"+"雨落。".repeat(36);
  const f=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")){reply(res,{title:"雨城",content:prose,majorChange:false,reason:"",states:[{kind:"item",subject:"铜钥匙",attribute:"持有人",value:"老周",statement:"fact",storyTime:"",quote:"铜钥匙在老周手中。"}]});return true;}
  });
  await done(f.app,await start(f.app,f.projectId,"接着写1章"));
  const record=f.app.snapshot().storyRecords![0];
  id(await f.app.dispatch({type:"story.reject",id:record.id,revision:record.revision}));
  expect(f.app.storyWorkspace({projectId:f.projectId}).current).toEqual([]);
});

it("one-click automatic continuation preserves spent usage after an allowance pause",async()=>{
  const f=await setup((phase,_input,res)=>{
    if(phase.includes("连续写作·规划")){reply(res,{plan:"沿用已有方向。",majorChange:false,reason:""},{prompt_tokens:900000,completion_tokens:10,total_tokens:900010});return true;}
  });
  const task=id(await f.app.dispatch({type:"conversation.send",projectId:f.projectId,text:"接着写1章"}));
  const paused=await done(f.app,task);expect(paused.status).toBe("paused");expect(paused.budgetUsed).toBe(900010);
  id(await f.app.dispatch({type:"writing.resume",id:task}));
  const result=await done(f.app,task);expect(result.status,result.reply).toBe("completed");
  expect(result.budgetUsed).toBeGreaterThan(900010);expect(result.tokenBudget).toBeGreaterThan(paused.tokenBudget);
  expect(f.app.snapshot().chapters).toHaveLength(1);
});

it("one-click continuation can finish length without duplicating chapters or asking for a decision",async()=>{
  let short=true;
  const f=await setup((phase,input,res)=>{
    if(short&&(phase.includes("连续写作·生成")||phase.includes("连续写作·修订"))){reply(res,{title:"雨城",content:"太短。",majorChange:false,reason:""});return true;}
  });
  const task=await start(f.app,f.projectId,"接着写1章");
  const paused=await done(f.app,task);expect(paused.status).toBe("paused");short=false;
  id(await f.app.dispatch({type:"writing.resume",id:task}));
  const result=await done(f.app,task);expect(result.status,result.reply).toBe("completed");
  expect(f.app.snapshot().chapters).toHaveLength(1);expect(f.app.snapshot().chapters[0].content.length).toBe(120);
});

it("unverifiable suspicions remain visible as notes without blocking or rewriting prose",async()=>{
  const f=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·检查")) {reply(res,{issues:[{category:"plot",impact:"blocking",reason:"模型怀疑地点矛盾",evidence:[{quote:"不存在的地点描述",source:lastChapter(input)},{quote:"另一句不存在的描述",source:lastChapter(input)}]}],majorChange:false,reason:""});return true;}
  });
  const job=await done(f.app,await start(f.app,f.projectId,"接着写1章"));
  expect(job.status,job.reply).toBe("completed");expect(job.chapters[0].revisionRounds).toBe(0);
  expect(job.reviewNotes?.join(" ")).toContain("模型怀疑地点矛盾");
  expect(job.reply).not.toContain("未发现需要处理的问题");
});

it("checking existing prose does not fill gaps, enforce new length or rewrite style advice",async()=>{
  const f=await setup();
  const ch=id(await f.app.dispatch({type:"chapter.create",projectId:f.projectId,ordinal:5,title:"已有第五章"}));
  id(await f.app.dispatch({type:"chapter.save",id:ch,revision:1,content:"作者特意写的短章。"}));
  const task=id(await f.app.dispatch({type:"writing.start",projectId:f.projectId,text:"检查并修正本章",goal:{kind:"append",startOrdinal:5,endOrdinal:5},reviewOnly:true} as Command));
  const job=await done(f.app,task);
  expect(job.status,job.reply).toBe("completed");
  expect(f.app.snapshot().chapters.map(c=>[c.ordinal,c.content])).toEqual([[5,"作者特意写的短章。"]]);
  expect(f.calls.every(c=>!c.phase.includes("·生成")&&!c.phase.includes("·修订")&&!c.phase.includes("·规划"))).toBe(true);
});

it("rejecting the latest automatic state does not revive an older holder",async()=>{
  const f=await setup((phase,input,res)=>{
    if(phase.includes("连续写作·生成")) {
      const holder=input.ordinal===1?"老周":"阿宁",quote=`铜钥匙在${holder}手中。`;
      reply(res,{title:`第${input.ordinal}章`,content:quote+"雨落。".repeat(36),majorChange:false,reason:"",states:[{kind:"item",subject:"铜钥匙",attribute:"持有人",value:holder,statement:"fact",storyTime:"",quote}]});return true;
    }
  });
  await done(f.app,await start(f.app,f.projectId,"接着写1章"));
  await done(f.app,await start(f.app,f.projectId,"接着写1章"));
  const record=f.app.snapshot().storyRecords!.find(r=>r.value==="阿宁")!;
  expect(f.app.storyWorkspace({projectId:f.projectId}).current[0].value).toBe("阿宁");
  id(await f.app.dispatch({type:"story.reject",id:record.id,revision:record.revision}));
  expect(f.app.storyWorkspace({projectId:f.projectId}).current).toEqual([]);
});

it("one length continuation schedules every remaining chapter",async()=>{
  let short=true;
  const f=await setup((phase,input,res)=>{
    if(short&&(phase.includes("连续写作·生成")||phase.includes("连续写作·修订"))){reply(res,{title:`第${input.ordinal}章`,content:"太短。",majorChange:false,reason:""});return true;}
  });
  const task=await start(f.app,f.projectId,"接着写3章");
  expect((await done(f.app,task)).status).toBe("paused");short=false;
  id(await f.app.dispatch({type:"writing.resume",id:task}));
  const result=await done(f.app,task);expect(result.status,result.reply).toBe("completed");
  expect(f.app.snapshot().chapters.map(c=>c.content.length)).toEqual([120,120,120]);
});

it("model length advice cannot force expansion while checking an existing short chapter",async()=>{
  const f=await setup((phase,input,res)=>{
    if(phase.includes("·检查")||phase.includes("·跨章复核")){reply(res,{issues:[{category:"length",impact:"local",reason:"建议扩写篇幅",evidence:[{quote:"作者特意写的短章。",source:lastChapter(input)}]}],majorChange:false,reason:""});return true;}
  });
  const ch=id(await f.app.dispatch({type:"chapter.create",projectId:f.projectId,ordinal:1,title:"短章"}));
  id(await f.app.dispatch({type:"chapter.save",id:ch,revision:1,content:"作者特意写的短章。"}));
  const task=id(await f.app.dispatch({type:"writing.start",projectId:f.projectId,text:"检查本章，保持篇幅",goal:{kind:"append",startOrdinal:1,endOrdinal:1},reviewOnly:true}));
  const result=await done(f.app,task);expect(result.status,result.reply).toBe("completed");
  expect(result.revisionJobIds).toEqual([]);expect(f.app.chapter(ch).content).toBe("作者特意写的短章。");
});

it("rechecking revised automatic evidence does not revive an older holder",async()=>{
  const f=await setup((phase,input,res)=>{
    if(phase.includes("·生成")) {const holder=input.ordinal===1?"老周":"阿宁",quote=`铜钥匙在${holder}手中。`;reply(res,{title:`第${input.ordinal}章`,content:quote+"雨落。".repeat(36),majorChange:false,reason:"",states:[{kind:"item",subject:"铜钥匙",attribute:"持有人",value:holder,statement:"fact",storyTime:"",quote}]});return true;}
  });
  await done(f.app,await start(f.app,f.projectId,"接着写2章"));
  const record=f.app.snapshot().storyRecords!.find(r=>r.value==="阿宁")!,ch=f.app.snapshot().chapters[1];
  id(await f.app.dispatch({type:"chapter.save",id:ch.id,revision:ch.revision,content:ch.content+"作者补充。"}));
  id(await f.app.dispatch({type:"story.recheck",id:record.id,revision:record.revision}));
  expect(f.app.storyWorkspace({projectId:f.projectId}).current).toEqual([]);
  expect(f.app.storyWorkspace({projectId:f.projectId}).blockedCount).toBeGreaterThan(0);
});

it("the current automatic capture wins when revision moves its quote earlier in the same chapter",async()=>{
  const quote="铜钥匙在老周手中。",states=[{kind:"item",subject:"铜钥匙",attribute:"持有人",value:"老周",statement:"fact",storyTime:"",quote}];
  const f=await setup((phase,input,res)=>{
    if(phase.includes("·生成")||phase.includes("·修订")) {reply(res,{title:"雨城",content:phase.includes("·生成")?"雨".repeat(141)+quote:quote+"雨".repeat(111),majorChange:false,reason:"",states});return true;}
  });
  const job=await done(f.app,await start(f.app,f.projectId,"接着写1章"));
  expect(job.status,job.reply).toBe("completed");expect(job.chapters[0].revisionRounds).toBe(1);
  const workspace=f.app.storyWorkspace({projectId:f.projectId});
  expect(workspace.current).toHaveLength(1);expect(workspace.current[0].value).toBe("老周");
  expect(workspace.current[0].evidence[0].revision).toBe(job.chapters[0].checkedRevision);
});
