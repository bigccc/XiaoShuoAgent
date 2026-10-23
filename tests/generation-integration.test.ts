import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AppServices} from "../src/main/services";
import type {CommandResult} from "../src/shared/types";
const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function id(r:CommandResult){if(!r.ok)throw Error(r.error.message);return r.entityId;}
async function setup(emptyFirst=false){
  let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
  const encoder=new TextEncoder();
  const dir=mkdtempSync(join(tmpdir(),"novel-preview-unit-"));
  let calls=0,total=0;
  const app=new AppServices({dataDir:dir,dialogs:{open:async()=>null,save:async()=>null},fetch:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(emptyFirst&&total++===0)return new Response(JSON.stringify({choices:[{message:{content:""},finish_reason:"stop"}]}),{headers:{"content-type":"application/json"}});
    if(body.messages[0].content.includes("连续写作·规划"))return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({plan:"保留雨夜旧书店",majorChange:false,reason:""})},finish_reason:"stop"}]}),{headers:{"content-type":"application/json"}});
    calls++;
    return new Response(new ReadableStream<Uint8Array>({start(c){controller=c;}}),{headers:{"content-type":"text/event-stream"}});
  }});
  cleanups.push(async()=>{try{controller?.close();}catch{}await app.dispose();rmSync(dir,{recursive:true,force:true});});
  const projectId=id(await app.dispatch({type:"project.create",title:"预览验收",chapterWords:120}));
  await app.dispatch({type:"profile.save",name:"隔离",baseUrl:"http://127.0.0.1:12345",model:"fixture",purpose:"writing"});
  const send=(text:string)=>controller!.enqueue(encoder.encode(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`));
  const end=()=>{controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));controller!.close();};
  return {app,projectId,send,end,wait:()=>expect.poll(()=>calls).toBeGreaterThan(0)};
}
it("conversation previews before completion without changing the saved reply",async()=>{
  const {app,projectId,send,end,wait}=await setup();
  expect((app as any).onGenerationDelta).toBeTypeOf("function");
  const events:any[]=[];(app as any).onGenerationDelta((e:any)=>events.push(e));
  const task=id(await app.dispatch({type:"conversation.send",projectId,text:"推荐一个故事方向"}));await wait();
  send('{"message":"雨城里的一家旧书店');
  await expect.poll(()=>events.some(e=>e.op==="append")).toBe(true);
  expect(app.snapshot().conversations.find(t=>t.id===task)?.reply).toBe("");
  expect((app as any).generationPreview(projectId).previews[0].parts[0].text).toBe("雨城里的一家旧书店");
  send('。"}');end();
  await expect.poll(()=>app.snapshot().conversations.find(t=>t.id===task)?.status).toBe("completed");
  expect(app.snapshot().conversations.find(t=>t.id===task)?.reply).toBe("雨城里的一家旧书店。");
  await expect.poll(()=>events.at(-1)?.op).toBe("end");
  expect(events.at(-1).outcome).toBe("completed");
});
it("continuous generation previews content while the chapter stays uncommitted",async()=>{
  const {app,projectId,send,end,wait}=await setup();
  expect((app as any).onGenerationDelta).toBeTypeOf("function");
  const events:any[]=[];(app as any).onGenerationDelta((e:any)=>events.push(e));
  const task=id(await app.dispatch({type:"writing.start",projectId,text:"试写开头",goal:{kind:"through",startOrdinal:1,endOrdinal:1},tokenBudget:100000,mode:"quick"}));await wait();
  send('{"content":"雨落在窗前。');
  await expect.poll(()=>events.some(e=>e.op==="append")).toBe(true);
  expect(app.snapshot().chapters.every(ch=>!ch.content)).toBe(true);
  send('","title":"雨夜","majorChange":false,"reason":""}');end();
  await expect.poll(()=>app.snapshot().writingJobs?.find(t=>t.id===task)?.status).not.toBe("running");
  expect(app.snapshot().chapters[0].content).toBe("雨落在窗前。");
});

it("successful retry streams the new attempt rather than a hidden retry placeholder",async()=>{
  const {app,projectId,send,end,wait}=await setup(true);
  const events:any[]=[];app.onGenerationDelta(e=>events.push(e));
  const task=id(await app.dispatch({type:"conversation.send",projectId,text:"推荐故事方向"}));await wait();
  send('{"message":"重试后仍然逐段显示');
  await expect.poll(()=>events.some(e=>e.op==="append"&&e.text.includes("重试后"))).toBe(true);
  send('。"}');end();
  await expect.poll(()=>app.snapshot().conversations.find(t=>t.id===task)?.status).toBe("completed");
});
