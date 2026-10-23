import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

let app: ElectronApplication, page: Page, dir: string;
async function launch() {
  app = await electron.launch({
    args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
}
async function openProject(server: Server, existingContent = "") {
  await page.evaluate(async ({ baseUrl, existingContent }) => {
    const project = await window.novel.invoke({ type: "project.create", title: "连续写作验收", chapterWords: 100 });
    if (!project.ok) throw Error(project.error.message);
    const profile = await window.novel.invoke({ type: "profile.save", pricing: { currency: "CNY", input: 0, output: 0 }, name: "写作验收模型", baseUrl, model: "fixture", purpose: "writing" });
    if (!profile.ok) throw Error(profile.error.message);
    if (existingContent) {
      const chapter = await window.novel.invoke({ type: "chapter.create", projectId: project.entityId, ordinal: 1, title: "已有第一章" });
      if (!chapter.ok) throw Error(chapter.error.message);
      const saved = await window.novel.invoke({ type: "chapter.save", id: chapter.entityId, revision: chapter.revision!, content: existingContent });
      if (!saved.ok) throw Error(saved.error.message);
    }
  }, { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, existingContent });
  await page.getByRole("button", { name: "打开 连续写作验收" }).click();
}
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-writing-ui-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

// Removing the writing job from the composer busy state, or routing these
// controls to conversation commands, must fail this real IPC/UI test.
test("continuous writing exposes its goal and can pause, survive restart, resume and cancel", async () => {
  let calls = 0;
  const server = createServer(async (req) => {
    for await (const _ of req) { /* Keep the model request pending until paused. */ }
    calls++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.getByLabel("创作消息").fill("帮我把前五章写完");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    let card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("第 1–5 章");
    await expect(card).toContainText("已保存 0 / 5 章");
    await expect(card).toContainText("已检查 0 / 5 章");
    await expect.poll(() => calls).toBe(1);
    await page.getByLabel("创作消息").fill("接着写五章");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await card.getByRole("button", { name: "暂停任务", exact: true }).click();
    await expect(card).toContainText("已暂停");
    await app.close();
    await launch();
    await page.getByRole("button", { name: "打开 连续写作验收" }).click();
    card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("已暂停");
    expect(calls).toBe(1);
    await card.getByRole("button", { name: "继续完成", exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    if (!(await card.locator(".writing-more").evaluate(el => (el as HTMLDetailsElement).open))) await card.locator(".writing-more > summary").click();
    await card.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(card).toContainText("已取消");
    const state = await page.evaluate(() => window.novel.snapshot());
    expect(state.chapters).toHaveLength(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/continuous-writing-minimum.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Dropping the composer tokenBudget argument would start a model call instead
// of retaining this task for the user to increase its total budget.
test("legacy explicit zero budgets allow execution and ordinary pause/resume without losing progress", async () => {
  let calls = 0;
  const server = createServer(async (req) => {
    for await (const _ of req) { /* Pending request is cancelled by the UI. */ }
    calls++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.evaluate(async () => {
      const state = await window.novel.snapshot();
      const result = await window.novel.invoke({type:"conversation.send", billing: { budgetMicros: 0 },projectId:state.projects[0].id,text:"写完前五章",tokenBudget:1000});
      if (!result.ok) throw Error(result.error.message);
    });
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect.poll(()=>calls).toBe(1);
    await card.getByRole("button",{name:"暂停任务",exact:true}).click();
    await expect(card).toContainText("已暂停");
    await card.getByRole("button",{name:"继续完成",exact:true}).click();
    await expect.poll(()=>calls).toBe(2);
    await expect(page.getByRole("dialog",{name:"确认本次 AI 花费"})).toHaveCount(0);
    if (!(await card.locator(".writing-more").evaluate(el => (el as HTMLDetailsElement).open))) await card.locator(".writing-more > summary").click();
    await card.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(card).toContainText("已取消");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// A saved chapter must be visible before its check finishes; completing only
// the first chapter or claiming a save is a successful check both fail here.
test("one request saves five chapters sequentially and keeps saved and checked progress separate", async () => {
  let releaseCheck: (() => void) | undefined;
  let checks = 0;
  const generated: number[] = [];
  const bodyText = "林舟推开书店的木门，门铃在雨声里响起。他把湿伞放进桶里，仔细看了看柜台上的信。".repeat(5).slice(0, 100);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find((message: { role: string }) => message.role === "system")?.content ?? "";
    const input = JSON.parse(body.messages.at(-1).content);
    const respond = (output: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } }));
    };
    if (system.includes("连续写作·规划")) respond({ plan: "前五章依次描写收信、拜访、调查、发现和归来，保持林舟与雨夜书店的主线。", majorChange: false, reason: "" });
    else if (system.includes("连续写作·生成")) {
      generated.push(input.ordinal);
      respond({ type: "json_object", title: `故事${input.ordinal}`, content: bodyText, majorChange: false, reason: "" });
    } else if (system.includes("连续写作·检查")) {
      checks++;
      if (checks === 1) releaseCheck = () => respond({ issues: [], majorChange: false, reason: "" });
      else respond({ issues: [], majorChange: false, reason: "" });
    } else if (system.includes("连续写作·跨章复核")) respond({ issues: [], majorChange: false, reason: "" });
    else { res.writeHead(500); res.end("Unexpected writing phase"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.getByLabel("创作消息").fill("写完前五章");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("已保存 1 / 5 章");
    await expect(card).toContainText("已检查 0 / 5 章");
    await expect(card).toContainText("正在检查已保存的章节");
    await expect.poll(() => !!releaseCheck).toBe(true);
    releaseCheck!();
    // Completing five serial generation/check calls is slower under Rosetta.
    await expect(card).toContainText("任务已完成", { timeout: 30000 });
    await expect(card).toContainText("已保存 5 / 5 章");
    await expect(card).toContainText("已检查 5 / 5 章");
    expect(generated).toEqual([1, 2, 3, 4, 5]);
    const snapshot = await page.evaluate(() => window.novel.snapshot());
    expect(snapshot.chapters.map((chapter) => chapter.ordinal).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.chapters.every((chapter) => chapter.content === bodyText)).toBe(true);
    await card.getByRole("button", { name: "查看正文", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(bodyText);
    await expect(page.getByLabel("当前章节")).toHaveValue(snapshot.chapters.find((chapter) => chapter.ordinal === 5)!.id);
    await page.screenshot({ path: "test-results/continuous-writing-completed.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Author input must return to the same paused writing task; treating the
// clarification as a new conversation would leave this task unfinished.
test("a major story change remains pending until the author supplies a decision and continues", async () => {
  let planningCalls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.find((message: { role: string }) => message.role === "system")?.content ?? "";
    const input = JSON.parse(body.messages.at(-1).content);
    let output: unknown;
    if (system.includes("连续写作·规划")) {
      planningCalls++;
      output = planningCalls === 1
        ? { plan: "需要改变主角身份才能采用这一方案。", majorChange: true, reason: "是否改变主角身份，需要作者决定。" }
        : { plan: "保留主角身份和已有主线，依次描写查信与来访。", majorChange: false, reason: "" };
    } else if (system.includes("连续写作·生成")) {
      output = { title: `故事${input.ordinal}`, content: "雨落在书店门口。林舟收好来信，等待旧友按约前来。".repeat(5).slice(0, 100), majorChange: false, reason: "" };
    } else if (system.includes("连续写作·检查") || system.includes("连续写作·跨章复核")) output = { issues: [], majorChange: false, reason: "" };
    else { res.writeHead(500); res.end("Unexpected writing phase"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await openProject(server);
    await page.getByLabel("创作消息").fill("写完前两章");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const card = page.getByRole("region", { name: "连续写作任务" });
    await expect(card).toContainText("仍有待处理事项");
    await expect(card).toContainText("是否改变主角身份");
    expect((await page.evaluate(() => window.novel.snapshot())).chapters).toHaveLength(0);
    await card.getByLabel("连续写作补充说明").fill("保留主角身份，按原主线推进。");
    await card.getByRole("button", { name: "按推荐处理并继续", exact: true }).click();
    await expect(card).toContainText("任务已完成");
    const state = await page.evaluate(() => window.novel.snapshot());
    expect(state.writingJobs).toHaveLength(1);
    expect(state.chapters).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("preserves existing prose and only generates missing chapters", async () => {
  const original="作者原稿只有一句。", revised="雨".repeat(100);
  const server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),phase=body.messages[0].content,input=JSON.parse(body.messages.at(-1).content);
    const value=phase.includes("·规划")?{plan:"保持原稿方向。",majorChange:false,reason:""}:
      phase.includes("·生成")||phase.includes("·修订")?{title:`故事${input.ordinal}`,content:revised,majorChange:false,reason:""}:{issues:[],majorChange:false,reason:""};
    res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  try {
    await openProject(server,original);
    await page.getByLabel("创作消息").fill("写完前两章");
    await page.getByRole("button",{name:"发送",exact:true}).click();
    const card=page.getByRole("region",{name:"连续写作任务"});
    await expect(card).toContainText("任务已完成");
    await expect(card.getByRole("region",{name:"修改预览"})).toHaveCount(0);
    const state=await page.evaluate(()=>window.novel.snapshot());
    expect(state.chapters[0].content).toBe(original);
    expect(state.chapters[1].content).toBe(revised);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("starts automatic writing from count and words without budget or mode choices", async () => {
  const server = createServer(async (req,res) => {
    let raw="";for await(const chunk of req) raw+=chunk;
    const body=JSON.parse(raw), phase=body.messages[0].content, input=JSON.parse(body.messages.at(-1).content);
    const value=phase.includes("·规划")?{plan:"遵循设定推进。",majorChange:false,reason:""}:
      phase.includes("·生成")||phase.includes("·修订")?{title:`雨夜${input.ordinal}`,content:"雨".repeat(120),majorChange:false,reason:""}:
      {issues:[],majorChange:false,reason:""};
    res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    await openProject(server,"雨".repeat(100));
    await page.getByText("写下一章 / 连续写作",{exact:true}).click();
    await expect(page.getByLabel("写作方式",{exact:true})).toHaveCount(0);
    await page.getByLabel("一次写几章",{exact:true}).fill("2");
    await page.getByLabel("每章大约多少字",{exact:true}).fill("120");
    await page.getByLabel("额外要求（可选）",{exact:true}).fill("雨夜推进线索");
    await page.screenshot({path:"test-results/simple-writing-form.png"});
    await page.getByRole("button",{name:"开始写作",exact:true}).click();
    const card=page.getByRole("region",{name:"连续写作任务"});
    await expect(card).toContainText("任务已完成");
    const state=await page.evaluate(()=>window.novel.snapshot());
    expect(state.writingJobs![0]).toMatchObject({budgetMode:"auto",targetWords:120,status:"completed"});
    expect(state.chapters.map(c=>c.ordinal)).toEqual([1,2,3]);
    expect(state.writingJobs![0].text).toContain("雨夜推进线索");
    await expect(card.getByText("需要你决定",{exact:true})).toHaveCount(0);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,680));
    await card.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(card.getByRole("button",{name:"查看正文",exact:true})).toBeInViewport();
    await page.screenshot({path:"test-results/simple-writing-result.png"});
    await page.getByRole("button",{name:"检查并修正本章",exact:true}).click();
    await expect.poll(async()=>{const s=await page.evaluate(()=>window.novel.snapshot());return s.writingJobs?.at(-1)?.reviewOnly&&s.writingJobs.at(-1)?.status==="completed";}).toBe(true);
    expect((await page.evaluate(()=>window.novel.snapshot())).chapters).toHaveLength(3);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("one decision applies multiple factual repairs and verifies once",async()=>{
  const original="今年十八岁。去年三十岁。同一刻灯亮着。同一刻灯没亮。"+"雨落。".repeat(25);
  let repairs=0,fixed=false;const phases:string[]=[];
  const server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),phase=body.messages[0].content,input=JSON.parse(body.messages.at(-1).content);phases.push(phase);
    let output:any={issues:[],majorChange:false,reason:""};
    if(phase.includes("·规划"))output={plan:"保持已有事实，推进本章。",majorChange:false,reason:""};
    else if(phase.includes("·生成"))output={title:"雨夜",content:original};
    else if(phase.includes("·定点修正")){repairs++;fixed=repairs===2;output={edits:fixed?[{quote:"去年三十岁。",replacement:"去年十七岁。"},{quote:"同一刻灯没亮。",replacement:"同一刻灯仍亮着。"}]:[],majorChange:false,reason:fixed?"":"需要确认处理方向"};}
    else if(!fixed&&phase.includes("·检查")){
      const match=[...input.context.matchAll(/\[chapter:([^@\]]+)@(\d+)\]/g)].at(-1)!;const source={kind:"chapter",id:match[1],revision:Number(match[2])};
      output={issues:[{category:"timeline",impact:"blocking",reason:"年龄冲突",evidence:[{quote:"今年十八岁。",source},{quote:"去年三十岁。",source}]},{category:"world",impact:"blocking",reason:"灯光状态冲突",evidence:[{quote:"同一刻灯亮着。",source},{quote:"同一刻灯没亮。",source}]}],majorChange:false,reason:""};
    }
    res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  try{
    await openProject(server);await page.getByLabel("创作消息").fill("写完前一章");await page.getByRole("button",{name:"发送",exact:true}).click();
    const card=page.getByRole("region",{name:"连续写作任务"});
    await expect(card).toContainText("集中确认处理方向");await expect(card).toContainText("年龄冲突");await expect(card).toContainText("灯光状态冲突");
    await expect(card.getByRole("button",{name:"按推荐处理并继续",exact:true})).toHaveCount(1);
    await expect(card.getByRole("button",{name:"按此方向修正并继续",exact:true})).toHaveCount(0);
    await page.screenshot({path:"test-results/combined-decision.png"});
    await card.getByRole("button",{name:"按推荐处理并继续",exact:true}).click();
    await expect(card).toContainText("任务已完成");
    expect((await page.evaluate(()=>window.novel.snapshot())).chapters[0].content).toBe(original.replace("去年三十岁。","去年十七岁。").replace("同一刻灯没亮。","同一刻灯仍亮着。"));
    expect(repairs).toBe(2);expect(phases.filter(p=>p.includes("·检查"))).toHaveLength(2);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
