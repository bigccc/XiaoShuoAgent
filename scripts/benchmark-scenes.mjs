import {createServer as createViteServer} from "vite";
import {createServer as createHttpServer} from "node:http";
import {writeFile,unlink} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import assert from "node:assert/strict";

// The baseline is the actual stage-2 writer, against the same store/provider fixtures.
const baselineCommit="4f08fb6";
const baselineFile=`src/main/.benchmark-scenes-${randomUUID()}.ts`;
const baselineSource=execFileSync("git",["show",`${baselineCommit}:src/main/writing.ts`],{encoding:"utf8"});
const vite=await createViteServer({logLevel:"error",configFile:false,server:{middlewareMode:true},appType:"custom"});
try {
  await writeFile(baselineFile,baselineSource,{flag:"wx"});
  const {WritingRunner:Baseline}=await vite.ssrLoadModule(`/${baselineFile}`);
  const {WritingRunner:Current}=await vite.ssrLoadModule("/src/main/writing.ts");
  const {Store}=await vite.ssrLoadModule("/src/main/store.ts");
  const {DomainService}=await vite.ssrLoadModule("/src/main/domain.ts");
  const {ChatProvider}=await vite.ssrLoadModule("/src/main/provider.ts");
  const cases=[];
  for(const targetWords of [200,2500,3000])for(const mode of ["stage2-baseline","scene-response"]){
    const calls=[];
    const http=createHttpServer(async(req,res)=>{
      let raw="";for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw),phase=body.messages[0].content,input=JSON.parse(body.messages.at(-1).content);
      let value;
      if(phase.includes("连续写作·规划"))value={plan:"阿宁抵达旧城，围绕失踪旧信发生冲突，在章末留出暗号线索。",majorChange:false,reason:""};
      else if(phase.includes("连续写作·生成")||phase.includes("连续写作·修订")){
        const content=("阿宁推开旧城的门，老周挡住去路。"+"雨滴敲着窗，旧信还没有找到。".repeat(targetWords)).slice(0,targetWords);
        const count=targetWords===200?2:3,base=Math.floor(targetWords/count);
        value={title:"雨夜旧信",content,majorChange:false,reason:"",...(mode==="scene-response"?{scenes:Array.from({length:count},(_,i)=>({title:["抵达","争信","钩子"][i],pov:"阿宁",goal:"找回失信",obstacle:"老周阻拦",turn:"发现刻痕",reveal:"暗号与旧城有关",words:base+(i<targetWords%count?1:0),hook:"门外的人知道暗号"}))}:{})};
      }else value={issues:[],majorChange:false,reason:""};
      const inputChars=body.messages.reduce((n,m)=>n+m.content.length,0),outputChars=JSON.stringify(value).length;
      // Deliberately synthetic, same deterministic counting in both arms.
      const prompt_tokens=Math.ceil(inputChars/2),completion_tokens=Math.ceil(outputChars/2);
      calls.push({phase:phase.split("。")[0],inputChars,outputChars,fixtureTokens:prompt_tokens+completion_tokens});
      res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:"stop"}],usage:{prompt_tokens,completion_tokens,total_tokens:prompt_tokens+completion_tokens}}));
    });
    await new Promise(r=>http.listen(0,"127.0.0.1",r));
    const store=new Store(":memory:"),domain=new DomainService(store),Runner=mode==="scene-response"?Current:Baseline;
    let runner;
    try{
      const p=domain.execute({type:"project.create",title:"旧城",chapterWords:targetWords});assert(p.ok);
      const profile=domain.execute({type:"profile.save",purpose:"writing",name:"fixture",model:"fixture",baseUrl:`http://127.0.0.1:${http.address().port}`});assert(profile.ok);
      runner=new Runner(store,domain,new ChatProvider({retryDelayMs:1}));
      const started=performance.now(),id=runner.start({type:"writing.start",projectId:p.entityId,text:"写完前一章，沿用阿宁查找旧信的章纲",goal:{kind:"through",startOrdinal:1,endOrdinal:1},tokenBudget:1000000});
      for(let i=0;i<2000&&store.get("writingJobs",id)?.status==="running";i++)await new Promise(r=>setTimeout(r,5));
      const elapsedMs=performance.now()-started,job=store.get("writingJobs",id),chapter=store.list("chapters")[0],plan=store.list("scenePlans")[0];
      assert.equal(job.status,"completed",job.reply);assert.equal(chapter.content.replace(/\s/g,"").length,targetWords);
      assert.equal(calls.length,4);assert.equal(plan?.cards.length??0,mode==="scene-response"?(targetWords===200?2:3):0);
      cases.push({mode,targetWords,actualWords:chapter.content.replace(/\s/g,"").length,lengthInRange:true,sceneCount:plan?.cards.length??0,sceneAllocatedWords:plan?.cards.reduce((n,c)=>n+c.words,0)??null,calls:calls.length,inputChars:calls.reduce((n,c)=>n+c.inputChars,0),outputChars:calls.reduce((n,c)=>n+c.outputChars,0),fixtureReportedTokens:job.usage.totalTokens,elapsedMs:+elapsedMs.toFixed(2),authorRetainedRatio:null,plotCompletionScore:null,repetitionScore:null});
    }finally{await runner?.dispose();store.close();await new Promise(r=>{http.closeAllConnections();http.close(r);});}
  }
  console.log(JSON.stringify({kind:"scene-protocol-comparison",generatedAt:new Date().toISOString(),baselineCommit,runtime:process.version,cases,limitations:"真实基线/当前写作器、SQLite与loopback HTTP；正文和Token均由确定性fixture提供，不证明真实模型的篇幅、重复、情节、采纳率或费用提升；耗时不含真实模型延迟。authorRetainedRatio及文学评分未测，保留null。"},null,2));
}finally{await unlink(baselineFile).catch(()=>{});await vite.close();}
