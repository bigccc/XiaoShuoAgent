import { MAX_WRITING_TOKEN_BUDGET } from "../../src/shared/writing";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

let app: ElectronApplication, page: Page, dir: string;
const formatFailure =
  "连续写作检查依据无法对应本次输入原文及来源版本（chapter:abc401def@2）";
const warnings = [
  "故事状态内容或原文引用格式不正确",
  "候选引用无法唯一对应正文",
  "有状态候选待核对，可在故事资料 → 状态与伏笔查看；未自动采纳。",
  "检查回复格式或证据引用需要整理；最多一次，仍严格核验原文，不清空疑点",
  "场景篇幅合计须等于本章计划字数，场景不能重复；场景卡未更新，正文已保留",
  "场景卡、来源或任务格式不正确；场景卡未更新，正文已保留",
  "本章正文完整，场景卡格式不完整，未采纳对应资料；原始回复已保留",
  "伏笔计划、埋设和回收须区分，并选择对应叙述性质",
  "定点修正未通过原句校验，原稿保留，需要人工核对",
];
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-notices-ui-"));
  app = await electron.launch({
    args: [
      ...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]),
      "--use-mock-keychain",
    ],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function seed(
  mode:
    | "completed"
    | "blocking"
    | "failed"
    | "local"
    | "stale"
    | "recovered"
    | "decision"
    | "connection"
    | "scene-paused"
    | "auto-scene-paused"
    | "budget",
) {
  const scenePaused = mode === "scene-paused" || mode === "auto-scene-paused";
  const data = await page.evaluate(async () => {
    const p = await window.novel.invoke({
      type: "project.create",
      title: "提醒界面验收",
    });
    if (!p.ok) throw Error(p.error.message);
    const chapters = [];
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      const c = await window.novel.invoke({
        type: "chapter.create",
        projectId: p.entityId,
        ordinal,
        title: `测试${ordinal}`,
      });
      if (!c.ok) throw Error(c.error.message);
      const saved = await window.novel.invoke({
        type: "chapter.save",
        id: c.entityId,
        revision: c.revision!,
        content: ordinal === 2 ? "同一天，她刚满二十岁。" : "她今年十七岁。",
      });
      if (!saved.ok) throw Error(saved.error.message);
      chapters.push({
        ordinal,
        chapterId: c.entityId,
        revision: saved.revision!,
      });
    }
    return { projectId: p.entityId, chapters };
  });
  if(scenePaused) {
    await page.evaluate(async data=>{
      const chapter=data.chapters[1];
      const cards=[{title:"开场",pov:"主角",goal:"修钟",obstacle:"找工具",turn:"打开抽屉",reveal:"找到工具",words:1500,hook:"开工"},{title:"维修",pov:"主角",goal:"修好",obstacle:"生锈",turn:"想到办法",reveal:"机芯松动",words:1500,hook:"继续"}];
      const result=await window.novel.invoke({type:"scene.save",projectId:data.projectId,chapterId:chapter.chapterId,targetWords:3000,cards});
      if(!result.ok)throw Error(result.error.message);
      const changed=await window.novel.invoke({type:"chapter.save",id:chapter.chapterId,revision:chapter.revision,content:"作者新改的正文。"});
      if(!changed.ok)throw Error(changed.error.message);
    },data);
  }
  {
    const db = new DatabaseSync(dir + "/works.sqlite");
    const now = new Date().toISOString();
    const finished = ["completed", "local", "stale", "recovered"].includes(
      mode,
    );
    const error =
      mode === "budget" ? "剩余 Token 预算不足，任务已暂停；提高总预算后可继续，已有章节和用量保留" : scenePaused ? "本章场景依据已改变，请编辑保存或重新规划后继续" : mode === "connection"
        ? "无法读取模型密钥，请重新配置模型"
        : formatFailure;
    const job = {
      id: "notice-job",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      projectId: data.projectId,
      text: "接着写4章",
      goal: { kind: "through", startOrdinal: 1, endOrdinal: 4 },
      status:
        mode === "blocking" || mode === "local" || mode === "decision"
          ? "awaiting-author"
          : scenePaused || mode === "budget" ? "paused" : finished
            ? "completed"
            : mode === "connection"
              ? "failed"
              : mode,
      phase: finished ? "done" : scenePaused ? "revising" : "checking",
      cursor: finished ? 4 : 1,
      chapters: data.chapters.map((c) => ({
        ordinal: c.ordinal,
        chapterId: c.chapterId,
        existing: false,
        status: "checked",
        revisionRounds: 0,
        savedRevision: c.revision,
        checkedRevision: mode === "stale" ? c.revision - 1 : c.revision,
      })),
      plan: "",
      planningDone: true,
      reviewCursor: 1,
      reviewRounds: 0,
      issues:
        mode === "blocking" || mode === "decision"
          ? [
              {
                category: "character",
                impact: "blocking",
                reason: "同一天的人物年龄不一致。",
                chapterId: data.chapters[1].chapterId,
                evidence: [
                  {
                    quote: "她今年十七岁。",
                    source: {
                      kind: "chapter",
                      id: data.chapters[0].chapterId,
                      revision: data.chapters[0].revision,
                    },
                  },
                  {
                    quote: "同一天，她刚满二十岁。",
                    source: {
                      kind: "chapter",
                      id: data.chapters[1].chapterId,
                      revision: data.chapters[1].revision,
                    },
                  },
                ],
              },
            ]
          : mode === "local" || mode === "budget"
            ? [
                {
                  category: "length",
                  impact: "local",
                  reason: "第4章篇幅不足。",
                  chapterId: data.chapters[3].chapterId,
                  evidence: [
                    {
                      quote: "她今年十七岁。",
                      source: {
                        kind: "chapter",
                        id: data.chapters[3].chapterId,
                        revision: data.chapters[3].revision,
                      },
                    },
                  ],
                },
              ]
            : [],
      revisionJobIds: [],
      warnings: mode === "recovered" ? [warnings[3], warnings[8]] : warnings,
      tokenBudget: 400000,
      budgetUsed: 30000,
      usage: {
        inputTokens: 20000,
        outputTokens: 10000,
        totalTokens: 30000,
        estimated: false,
      },
      calls: 10,
      reply:
        mode === "failed" || mode === "connection" || scenePaused || mode === "budget"
          ? error
          : mode === "decision"
            ? "需要改变已经确认的结局，是否保持原主线？"
            : mode === "blocking"
              ? "请核对这两处年龄并说明处理意见。"
              : "已完成本轮写作",
      ...(mode === "failed" || mode === "connection" || scenePaused || mode === "budget" ? { error } : {}),
    };
    if(mode === "auto-scene-paused") {
      const row=db.prepare("SELECT id,json FROM scenePlans WHERE json_extract(json,'$.chapterId')=?").get(data.chapters[1].chapterId)!;
      const plan=JSON.parse(String(row.json));plan.origin="writing";
      db.prepare("UPDATE scenePlans SET json=? WHERE id=?").run(JSON.stringify(plan),row.id as string);
      job.goal={kind:"append",startOrdinal:2,endOrdinal:2};job.cursor=0;job.reviewCursor=0;
      const progress=job.chapters[1];job.chapters=[{...progress,status:"written",savedRevision:progress.savedRevision+1,checkedRevision:progress.checkedRevision+1}];
    }
    db.prepare("INSERT INTO writingJobs(id,json) VALUES(?,?)").run(
      job.id,
      JSON.stringify(job),
    );
    db.close();
  }
  await page.getByRole("button", { name: "打开 提醒界面验收" }).click();
  return page.getByRole("region", { name: "连续写作任务" });
}
test("historical diagnostics stay folded while incomplete auxiliary work has one honest summary", async () => {
  const card = await seed("completed");
  for (const text of warnings)
    await expect(card.getByText(text, { exact: true })).not.toBeVisible();
  await expect(card.getByRole("region", { name: "辅助资料整理记录" })).not.toBeVisible();
  await card.locator("summary").filter({ hasText: /^更多$/ }).click();
  await expect(card.getByRole("region", { name: "辅助资料整理记录" })).toBeVisible();
  await expect(card).toContainText("曾有未更新或未采纳的辅助资料");
  await expect(card).toContainText("可以继续写下一批");
  await card.screenshot({ path: "test-results/writing-notices-summary.png" });
  await card.locator("summary").filter({ hasText: "技术详情" }).click();
  for (const text of warnings)
    await expect(card.getByText(text, { exact: true })).toBeVisible();
  await card.locator("summary").filter({ hasText: "技术详情" }).click();
  await card.getByRole("button", { name: "核对状态与伏笔" }).click();
  await expect(
    page.getByRole("button", { name: "状态与伏笔", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});
test("blocking findings show their chapter, original evidence and a working edit entry", async () => {
  const card = await seed("blocking");
  await expect(card).toContainText("需要先处理");
  await expect(
    card.getByText("同一天，她刚满二十岁。", { exact: true }),
  ).toBeVisible();
  await card.screenshot({ path: "test-results/writing-notices-blocking.png" });
  expect(
    await page.evaluate(async () =>
      Object.keys(await window.novel.writingIssues("notice-job")).sort(),
    ),
  ).toEqual(["issues", "revision"]);
  await card.getByRole("button", { name: "查看第2章" }).click();
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "同一天，她刚满二十岁。",
  );
});
test("a current failure has one readable action prompt and keeps the raw error folded", async () => {
  const card = await seed("failed");
  await expect(card.getByRole("alert")).toHaveCount(1);
  await expect(card.getByRole("alert")).toContainText("检查未完成");
  await expect(
    card.getByText(formatFailure, { exact: true }),
  ).not.toBeVisible();
  await expect(
    card.getByRole("button", { name: "继续完成", exact: true }),
  ).toBeVisible();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 680),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/writing-notices-failed.png" });
});
test("local suggestions stay visible without falsely blocking the next batch", async () => {
  const card = await seed("local");
  await expect(card).toContainText("可以继续写下一批");
  await expect(
    card.getByText("第4章篇幅不足。", { exact: true }),
  ).not.toBeVisible();
  await card.locator("summary").filter({ hasText: "条写作建议" }).click();
  await expect(
    card.getByText("第4章篇幅不足。", { exact: true }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "查看第4章" })).toBeVisible();
});
test("a changed manuscript does not inherit a current all-clear from an old completed job", async () => {
  const card = await seed("stale");
  await expect(card).toContainText("正文有更新");
  await expect(card).toContainText("已检查 0 / 4 章");
  await expect(
    card.getByText("本轮写作与检查已完成，可以查看正文，也可以继续写下一批。", {
      exact: true,
    }),
  ).not.toBeVisible();
});
test("recovered processing messages do not create a current warning or auxiliary failure", async () => {
  const card = await seed("recovered");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(
    card.getByRole("region", { name: "辅助资料整理记录" }),
  ).toHaveCount(0);
  await expect(card.getByText(warnings[8], { exact: true })).not.toBeVisible();
  await expect(card).toContainText("可以继续写下一批");
});
test("a creative decision remains visible alongside existing findings", async () => {
  const card = await seed("decision");
  await expect(
    card
      .getByText("需要改变已经确认的结局，是否保持原主线？", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  await expect(card.getByLabel("连续写作补充说明")).toBeVisible();
  await expect(card).toContainText("同一天的人物年龄不一致。");
});
test("a key failure leads to settings instead of repeated blind retries", async () => {
  const card = await seed("connection");
  await expect(card.getByRole("alert")).toContainText("AI 连接");
  await card.getByRole("button", { name: "检查 AI 连接" }).click();
  await expect(
    page.getByRole("button", { name: "AI 连接", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("scene-paused tasks show the blocking reason and recover after author scene review",async()=>{
  const card=await seed("scene-paused");
  await expect(card.getByText(/保存场景计划后/)).toBeVisible();
  await expect(card.getByRole("button",{name:"继续完成",exact:true})).toHaveCount(0);
  await card.getByRole("button",{name:"查看第2章场景卡",exact:true}).click();
  await page.getByRole("button",{name:"本章场景",exact:true}).click();
  const scenes=page.getByRole("region",{name:"本章场景计划",exact:true});
  await expect(scenes.getByText(/场景依据或绑定原文已改变/)).toBeVisible();
  await scenes.getByRole("button",{name:"保存场景计划",exact:true}).click();
  await expect(card.getByRole("button",{name:"重新检查并继续",exact:true})).toBeEnabled();
  await expect(page.getByLabel("章节正文",{exact:true})).toHaveValue("作者新改的正文。");
});

test("one Continue click visibly resumes a paused task with stale automatic scene cards",async()=>{
  let calls=0;
  const server=createServer(async(req,res)=>{
    let raw="";for await(const c of req)raw+=c;
    calls++;
    const phase=JSON.parse(raw).messages[0].content;
    const output=phase.includes("连续写作·修订")?{title:"新版正文",content:"雨".repeat(3000),majorChange:false,reason:""}:{issues:[],majorChange:false,reason:""};
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const card=await seed("auto-scene-paused");
    await page.evaluate(async baseUrl=>{
      const r=await window.novel.invoke({type:"profile.save", pricing: { currency: "CNY", input: 0, output: 0 },name:"场景续跑验收",model:"fixture",baseUrl,purpose:"writing"});if(!r.ok)throw Error(r.error.message);
    },`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    await expect(card).toContainText("过期的自动场景卡不会作为依据");
    await card.getByRole("button",{name:"重新检查并继续",exact:true}).click();
    await expect(card.getByText("✓ 任务已完成")).toBeVisible();
    const s=await page.evaluate(()=>window.novel.snapshot());
    expect(s.chapters.find(c=>c.ordinal===2)?.content).toBe("雨".repeat(3000));
    expect(s.writingJobs?.find(j=>j.id==="notice-job")?.status).toBe("completed");
    expect(calls).toBe(3);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("budget pause presents one paid primary action and keeps optional controls folded",async({},testInfo)=>{
  let calls=0;
  const server=createServer(async(req)=>{for await(const _ of req){}calls++;});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const card=await seed("budget");
    await page.evaluate(async baseUrl=>{
      const r=await window.novel.invoke({type:"profile.save", pricing: { currency: "CNY", input: 0, output: 0 },name:"额度界面验收",model:"fixture",baseUrl,purpose:"writing"});if(!r.ok)throw Error(r.error.message);
    },`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    const primary=card.getByRole("button",{name:"继续完成",exact:true});
    await expect(primary).toHaveClass(/primary/);
    await expect(card.getByRole("button",{name:"继续完成",exact:true})).toHaveCount(1);
    await expect(card.getByRole("button").filter({visible:true})).toHaveCount(2);
    await expect(card.getByText("第4章篇幅不足。",{exact:true})).not.toBeVisible();
    await expect(card.getByRole("button",{name:"取消任务",exact:true})).not.toBeVisible();
    await expect(card.getByRole("button",{name:"核对状态与伏笔",exact:true})).not.toBeVisible();
    await expect(card.getByText(/400,000.*500,000/)).toBeVisible();
    expect((await page.evaluate(()=>window.novel.snapshot())).writingJobs?.find(j=>j.id==="notice-job")?.tokenBudget).toBe(400000);
    expect(calls).toBe(0);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,680));
    await expect(card.getByRole("button",{name:"查看正文",exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await primary.scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath("budget-primary-actions.png")});
    await card.locator("summary").filter({hasText:/^更多$/}).click();
    await expect(card.getByRole("button",{name:"取消任务",exact:true})).toBeVisible();
    await expect(card.getByRole("button",{name:"核对状态与伏笔",exact:true})).toBeVisible();
    expect(calls).toBe(0);
    await primary.click();
    await expect.poll(()=>calls).toBe(1);
    const state=await page.evaluate(()=>window.novel.snapshot());const job=state.writingJobs!.find(j=>j.id==="notice-job")!;
    expect(job.tokenBudget).toBe(500000);expect(job.budgetUsed).toBeGreaterThanOrEqual(30000);
    await card.getByRole("button",{name:"取消任务",exact:true}).click();
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test("resolved blocking findings collapse when only local suggestions remain",async()=>{
  const card=await seed("blocking");
  await expect(card.getByText("同一天的人物年龄不一致。",{exact:true})).toBeVisible();
  const db=new DatabaseSync(dir+"/works.sqlite");
  const job=JSON.parse(String(db.prepare("SELECT json FROM writingJobs WHERE id='notice-job'").get()!.json));
  job.status="paused";job.error="剩余 Token 预算不足，任务已暂停";job.revision++;job.issues=[{...job.issues[0],category:"length",impact:"local",reason:"篇幅建议可以稍后查看。"}];
  db.prepare("UPDATE writingJobs SET json=? WHERE id='notice-job'").run(JSON.stringify(job));db.close();
  await expect(card.getByRole("button",{name:"继续完成",exact:true})).toBeVisible();
  await expect(card.getByText("篇幅建议可以稍后查看。",{exact:true})).not.toBeVisible();
  await card.locator("summary").filter({hasText:"条写作建议"}).click();
  await expect(card.getByText("篇幅建议可以稍后查看。",{exact:true})).toBeVisible();
});
test("the task maximum does not offer an ineffective increase or continue action",async()=>{
  const card=await seed("budget");
  const db=new DatabaseSync(dir+"/works.sqlite");const job=JSON.parse(String(db.prepare("SELECT json FROM writingJobs WHERE id='notice-job'").get()!.json));
  job.tokenBudget=MAX_WRITING_TOKEN_BUDGET;job.budgetUsed=MAX_WRITING_TOKEN_BUDGET-1000;job.revision++;
  db.prepare("UPDATE writingJobs SET json=? WHERE id='notice-job'").run(JSON.stringify(job));db.close();
  await expect(card.getByRole("button",{name:"继续完成",exact:true})).toHaveCount(0);
  await expect(card.getByRole("button",{name:"继续完成",exact:true})).toHaveCount(0);
  await expect(card.getByRole("button",{name:"查看正文",exact:true})).toHaveClass(/primary/);
  await expect(card).toContainText("额度已达上限");
  await expect(card).not.toContainText("增加额度后可继续");
});
