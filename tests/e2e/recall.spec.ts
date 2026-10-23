import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
let app:ElectronApplication, page:Page, dir:string;
async function launch() {
  app=await electron.launch({args:[...(process.env.NOVEL_PACKAGED_EXECUTABLE?[]:["out/main/index.js"]),"--use-mock-keychain"],executablePath:process.env.NOVEL_PACKAGED_EXECUTABLE,env:{...process.env,NOVEL_TEST:"1",NOVEL_DATA_DIR:dir}});
  page=await app.firstWindow(); await page.waitForLoadState();
}
test.beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"novel-recall-ui-"));await launch();});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});await app?.close();await rm(dir,{recursive:true,force:true});});
test("authors can inspect actual remote evidence, see changed sources and reopen it in a narrow window",async()=>{
  let calls=0;
  const server=createServer(async(req,res)=>{
    for await(const _chunk of req) {} calls++;
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({message:"已参考第8章的铜钥匙原文。"})}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  try {
    const seed=await page.evaluate(async(baseUrl)=>{
      const p=await window.novel.invoke({type:"project.create",title:"远章召回验收"}); if(!p.ok)throw Error(p.error.message);
      await window.novel.invoke({type:"profile.save", pricing: { currency: "CNY", input: 0, output: 0 },name:"fixture",model:"fixture",purpose:"writing",baseUrl});
      let oldId="";
      for(const ordinal of [8,117,118,119,120]) {
        const c=await window.novel.invoke({type:"chapter.create",projectId:p.entityId,ordinal,title:`验收${ordinal}`}); if(!c.ok)throw Error(c.error.message);
        const saved=await window.novel.invoke({type:"chapter.save",id:c.entityId,revision:c.revision!,content:ordinal===8?"铜钥匙由老周保管。":"雨落在窗前。"}); if(!saved.ok)throw Error(saved.error.message);
        if(ordinal===8){oldId=c.entityId;await window.novel.invoke({type:"chapter.confirm",id:c.entityId,revision:saved.revision!});}
      }
      return {projectId:p.entityId,oldId};
    },`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    await page.getByRole("button",{name:"打开 远章召回验收"}).click();
    await page.getByLabel("创作消息").fill("讨论铜钥匙的去向");
    await page.getByRole("button",{name:"发送",exact:true}).click();
    await expect(page.getByText("已参考第8章的铜钥匙原文。",{exact:true})).toBeVisible();
    await page.getByText("本次参考的远章原文",{exact:true}).click();
    const evidence=page.getByLabel("远章原文出处");
    await expect(evidence).toContainText("第8章");
    await expect(evidence).toContainText("铜钥匙由老周保管。");
    await page.evaluate(async oldId=>{
      const c=await window.novel.chapter(oldId);
      await window.novel.invoke({type:"chapter.save",id:c.id,revision:c.revision,content:"铜钥匙已经归还阿宁。"});
    },seed.oldId);
    await expect(evidence).toContainText("原文已改变");
    await app.close(); await launch();
    await page.getByRole("button",{name:"打开 远章召回验收"}).click();
    await page.getByText("本次参考的远章原文",{exact:true}).click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,680));
    await expect(page.getByLabel("远章原文出处")).toContainText("原文已改变");
    await page.getByLabel("远章原文出处").getByText(/原文已改变/).scrollIntoViewIfNeeded();
    await expect(page.getByLabel("远章原文出处").getByText(/原文已改变/)).toBeVisible();
    expect(calls).toBe(1);
    await page.screenshot({path:"docs/screenshots/context-recall-narrow-20261013.png"});
  } finally {await new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());});}
});
