import {createServer} from "node:http";
import {test,expect,_electron as electron,type ElectronApplication,type Page} from "@playwright/test";
import {mkdtemp,rm} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";
let app:ElectronApplication,page:Page,dir:string;
async function launch(){app=await electron.launch({args:[...(process.env.NOVEL_PACKAGED_EXECUTABLE?[]:["out/main/index.js"]),"--use-mock-keychain"],executablePath:process.env.NOVEL_PACKAGED_EXECUTABLE,env:{...process.env,NOVEL_TEST:"1",NOVEL_DATA_DIR:dir}});page=await app.firstWindow();await page.waitForLoadState();}
test.beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"novel-story-ui-"));await launch();});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});await app?.close();await rm(dir,{recursive:true,force:true});});
async function seed(){return page.evaluate(async()=>{const p=await window.novel.invoke({type:"project.create",title:"状态与伏笔验收"});if(!p.ok)throw Error();const ids:string[]=[];for(const [ordinal,content] of [[8,"铜钥匙在老周手中。钥匙刻痕像一串暗号。"],[120,"阿宁终于解开钥匙刻痕中的暗号。"]] as const){const c=await window.novel.invoke({type:"chapter.create",projectId:p.entityId,ordinal,title:`故事${ordinal}`});if(!c.ok)throw Error();await window.novel.invoke({type:"chapter.save",id:c.entityId,revision:1,content});await window.novel.invoke({type:"chapter.confirm",id:c.entityId,revision:2});ids.push(c.entityId);}return{projectId:p.entityId,ids};});}
async function open(){await page.getByRole("button",{name:"打开 状态与伏笔验收"}).click();await page.getByRole("button",{name:"故事资料",exact:true}).click();await expect(page.getByRole("button",{name:"状态与伏笔",exact:true})).toBeVisible();await page.getByRole("button",{name:"状态与伏笔",exact:true}).click();}
test("author creates a source-bound candidate, adopts it and sees a stale source without losing history",async()=>{
  const f=await seed();await open();await page.getByLabel("记录类型",{exact:true}).selectOption("item");await page.getByLabel("人物或物品",{exact:true}).fill("铜钥匙");await page.getByLabel("属性或信息主题",{exact:true}).fill("持有人");await page.getByLabel("状态或事件",{exact:true}).fill("老周");
  await page.getByLabel("引用章节",{exact:true}).selectOption(f.ids[0]);await page.getByLabel("引用原文",{exact:true}).fill("铜钥匙在老周手中。");await page.getByRole("button",{name:"定位原文",exact:true}).click();await page.getByRole("button",{name:"添加此引用",exact:true}).click();await page.getByRole("button",{name:"保存候选",exact:true}).click();
  const list=page.getByLabel("状态记录列表");await expect(list).toContainText("老周");await list.getByRole("button",{name:"确认并使用",exact:true}).click();await expect(page.getByLabel("已采纳状态")).toContainText("铜钥匙");
  await page.getByLabel("故事内时间（可选）",{exact:true}).fill("上午");await page.getByRole("button",{name:"保存候选",exact:true}).click();await expect(list).toContainText("上午");
  await page.evaluate(async id=>{const c=await window.novel.chapter(id);await window.novel.invoke({type:"chapter.save",id,revision:c.revision,content:"铜钥匙在老周手中。钥匙刻痕像一串暗号。雨停了。"});},f.ids[0]);
  await expect(list).toContainText("来源需复核");await expect(page.getByLabel("已采纳状态")).not.toContainText("持有人：老周");await list.getByText("历史版本",{exact:true}).click();await expect(list.getByText(/版本1/)).toBeVisible();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,680));await list.scrollIntoViewIfNeeded();await page.screenshot({path:"docs/screenshots/story-state-narrow-20261013.png"});
});
test("foreshadowing completion requires separate planting and resolution evidence and keeps dirty form protection",async()=>{
  const f=await seed();await open();await page.getByLabel("记录类型",{exact:true}).selectOption("foreshadowing");await page.getByLabel("伏笔进展",{exact:true}).selectOption("resolved");await page.getByLabel("人物或物品",{exact:true}).fill("钥匙暗号");await page.getByLabel("状态或事件",{exact:true}).fill("暗号已解开");
  for(const [id,quote] of [[f.ids[0],"钥匙刻痕像一串暗号。"],[f.ids[1],"阿宁终于解开钥匙刻痕中的暗号。"]]){await page.getByLabel("引用章节",{exact:true}).selectOption(id);await page.getByLabel("引用原文",{exact:true}).fill(quote);await page.getByRole("button",{name:"定位原文",exact:true}).click();await page.getByRole("button",{name:"添加此引用",exact:true}).click();}
  await page.getByRole("button",{name:"保存候选",exact:true}).click();await page.getByLabel("状态记录列表").getByRole("button",{name:"确认并使用",exact:true}).click();await expect(page.getByLabel("伏笔清单")).toContainText("已回收");
  await page.getByLabel("人物或物品",{exact:true}).fill("未保存的另一条线索");await page.getByRole("button",{name:"创作",exact:true}).click();await expect(page.getByRole("dialog")).toBeVisible();await page.getByRole("button",{name:"返回编辑",exact:true}).click();await expect(page.getByLabel("人物或物品",{exact:true})).toHaveValue("未保存的另一条线索");
});

test("author resumes a budget-paused extraction after restart without automatic requests",async()=>{
  let calls=0;const server=createServer(async(req,res)=>{for await(const _chunk of req){}calls++;res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({states:[{kind:"event",subject:"阿宁",attribute:"暗号",value:"已解开",statement:"fact",storyTime:"",quote:"阿宁终于解开钥匙刻痕中的暗号。"}]})}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  try{await seed();await page.evaluate(async baseUrl=>{await window.novel.invoke({type:"profile.save", pricing: { currency: "CNY", input: 0, output: 0 },name:"fixture",purpose:"checking",baseUrl,model:"fixture"});},`http://127.0.0.1:${(server.address() as {port:number}).port}`);await open();
    await page.getByText("高级提取设置",{exact:true}).click();await page.getByLabel("本次提取Token总预算",{exact:true}).fill("1");await page.getByRole("button",{name:"提取章节状态",exact:true}).click();await expect(page.getByLabel("状态提取任务")).toContainText("已暂停");expect(calls).toBe(0);
    await app.close();await launch();await open();expect(calls).toBe(0);await page.getByLabel("状态提取任务").getByRole("button",{name:"增加本次调用额度并继续",exact:true}).click();await expect(page.getByLabel("状态提取任务")).toContainText("提取执行结束");await expect(page.getByLabel("状态记录列表")).toContainText("暗号：已解开");expect(calls).toBe(1);
  }finally{await new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());});}
});

test("archived records can be found after leaving the page and restored with their history",async()=>{
  const f=await seed();await page.evaluate(async projectId=>{const r=await window.novel.invoke({type:"story.save",projectId,entry:{kind:"foreshadowing",subject:"失踪旧信",attribute:"线索",value:"计划埋设",statement:"plan",storyTime:"",foreshadowingStage:"planned"},evidence:[]});if(!r.ok)throw Error();},f.projectId);await open();
  const list=page.getByLabel("状态记录列表");await list.getByRole("button",{name:"归档记录",exact:true}).click();await expect(list).not.toContainText("失踪旧信");
  await page.getByRole("button",{name:"创作",exact:true}).click();await page.getByRole("button",{name:"故事资料",exact:true}).click();await page.getByRole("button",{name:"状态与伏笔",exact:true}).click();
  await page.getByLabel("记录筛选",{exact:true}).selectOption("archived");await expect(list).toContainText("失踪旧信");await list.getByText("历史版本",{exact:true}).click();await expect(list).toContainText("版本1");
  await list.getByRole("button",{name:"恢复记录",exact:true}).click();await page.getByLabel("记录筛选",{exact:true}).selectOption("active");await expect(list).toContainText("失踪旧信");
});
