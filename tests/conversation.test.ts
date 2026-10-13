import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AppServices } from "../src/main/services";
import { Store } from "../src/main/store";
import { ConversationRunner } from "../src/main/conversation";
import { DomainService } from "../src/main/domain";
import { ChatProvider } from "../src/main/provider";
import { ProjectFiles } from "../src/main/files";
import type { Command, CommandResult } from "../src/shared/types";
import { chapter } from "./fixtures/recall-cases";

const apps: AppServices[] = [],
  dirs: string[] = [],
  servers: Server[] = [];
const legacyRunners: { runner: ConversationRunner; store: Store }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { runner, store } of legacyRunners.splice(0)) { await runner.dispose(); store.close(); }
  await Promise.all(apps.splice(0).map((a) => a.dispose()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function id(r: CommandResult) {
  if (!r.ok) throw Error(r.error.message);
  return r.entityId;
}
function reply(res: ServerResponse, data: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: typeof data === "string" ? data : JSON.stringify(data),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    }),
  );
}
async function setup(
  handler: (body: any, res: ServerResponse) => void,
  options = {},
) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    handler(JSON.parse(raw), res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "novel-conversation-"));
  dirs.push(dir);
  const app = new AppServices({
    dataDir: dir,
    dialogs: { open: async () => null, save: async () => null },
    provider: { retryDelayMs: 1 },
    ...options,
  });
  apps.push(app);
  const projectId = id(
    await app.dispatch({ type: "project.create", title: "未命名故事" }),
  );
  id(
    await app.dispatch({
      type: "profile.save",
      name: "对话模型",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      model: "fixture",
      purpose: "writing",
    }),
  );
  return { app, projectId, dir };
}
async function send(
  app: AppServices,
  projectId: string,
  text: string,
  extra = {},
) {
  return id(
    await app.dispatch({
      type: "conversation.send",
      projectId,
      text,
      ...extra,
    } as Command),
  );
}
async function done(app: AppServices, turnId: string) {
  await expect
    .poll(
      () =>
        (app.snapshot() as any).conversations.find((t: any) => t.id === turnId)
          ?.status,
      { timeout: 5000 },
    )
    .not.toBe("running");
  return (app.snapshot() as any).conversations.find(
    (t: any) => t.id === turnId,
  );
}

// Keep the legacy response-contract tests at that runner boundary. Public batch
// requests now route to WritingRunner and have their own end-to-end tests.
function legacySend(dir: string, projectId: string, text: string) {
  const store = new Store(join(dir, "works.sqlite"));
  const runner = new ConversationRunner(store, new DomainService(store), new ChatProvider({ retryDelayMs: 1 }));
  legacyRunners.push({ runner, store });
  return runner.start({ type: "conversation.send", projectId, text });
}

it("recall: sends remote original evidence, persists the actual excerpt and excludes later chapters for early edits", async () => {
  let prompt = "";
  const { app, projectId, dir } = await setup((body, res) => { prompt = JSON.stringify(body.messages); reply(res, { message: "已参考旧章讨论铜钥匙。" }); });
  const seed = new Store(join(dir,"works.sqlite"));
  for (const [n, text] of [[8,"铜钥匙由老周保管。"], [117,"雨停了。"], [118,"她进门。"], [119,"灯亮了。"], [120,"阿宁回来。"], [121,"未来暗号已经揭晓。"]] as const)
    seed.put("chapters", chapter(`recall-${n}`, n, text, { projectId }));
  seed.close();
  const turn = await done(app, await send(app, projectId, "讨论铜钥匙的去向", {chapterId:"recall-120"}));
  expect(turn.status).toBe("completed");
  expect(prompt).toContain("铜钥匙由老周保管。");
  expect(prompt).not.toContain("未来暗号已经揭晓。");
  expect(turn.contextReferences).toHaveLength(1);
  expect(turn.contextReferences[0]).toMatchObject({source:{id:"recall-8",revision:1},excerpt:"铜钥匙由老周保管。"});
});
it("recall: a partial old-chapter reference does not authorize overwriting that chapter", async () => {
  const { app, projectId, dir } = await setup((_body, res) => reply(res, { message:"提议改旧章", chapters:[{id:"remote8",title:"覆盖",content:"错误覆盖",stage:"complete"}] }));
  const seed = new Store(join(dir,"works.sqlite"));
  seed.put("chapters", chapter("remote8",8,"铜钥匙交给老周。"+"甲".repeat(1200),{projectId}));
  for (const n of [117,118,119,120]) seed.put("chapters",chapter(`r${n}`,n,"雨落。",{projectId}));
  seed.close();
  const turn = await done(app, await send(app, projectId, "继续讨论铜钥匙", {chapterId:"r120"}));
  expect(turn.contextReferences?.[0].source.id).toBe("remote8");
  expect(turn.status).toBe("awaiting-author");
  expect(app.snapshot().chapters.find(c=>c.id==="remote8")!.content).toContain("铜钥匙交给老周。");
});
it("recall: changing a remote source while the model is answering rejects the late write", async () => {
  let respond: (()=>void) | undefined;
  const { app, projectId, dir } = await setup((_body, res) => { respond=()=>reply(res,{message:"已续写",chapters:[{id:"r120",title:"当前章",content:"模型旧回复",stage:"complete"}]}); });
  const seed = new Store(join(dir,"works.sqlite"));
  seed.put("chapters", chapter("remote8",8,"铜钥匙交给老周。",{projectId}));
  for (const n of [117,118,119,120]) seed.put("chapters",chapter(`r${n}`,n,"雨落。",{projectId}));
  seed.close();
  const turnId = await send(app,projectId,"继续完成这一章，铜钥匙交给谁",{chapterId:"r120"});
  await expect.poll(()=>!!respond).toBe(true);
  const old=app.snapshot().chapters.find(c=>c.id==="remote8")!;
  id(await app.dispatch({type:"chapter.save",id:old.id,revision:old.revision,content:"铜钥匙已经归还阿宁。"}));
  respond!();
  const turn=await done(app,turnId);
  expect(turn.status).toBe("failed");
  expect(app.snapshot().chapters.find(c=>c.id==="r120")!.content).toBe("雨落。");
});
it("recall: explicit later-chapter scope takes precedence over the editor's selected earlier chapter", async () => {
  let prompt="";
  const {app,projectId,dir}=await setup((body,res)=>{prompt=JSON.stringify(body.messages);reply(res,{message:"讨论完成"});});
  const store=new Store(join(dir,"works.sqlite"));
  store.put("chapters",chapter("remote8",8,"铜钥匙由老周保管。",{projectId}));
  for(const n of [117,118,119,120]) store.put("chapters",chapter(`r${n}`,n,`近期${n}原文。`,{projectId}));
  const runner=new ConversationRunner(store,new DomainService(store),new ChatProvider({retryDelayMs:1}));
  legacyRunners.push({runner,store});
  const turn=await done(app,runner.start({type:"conversation.send",projectId,text:"修改第120章，继续寻找铜钥匙",chapterId:"remote8"}));
  expect(turn.status).toBe("completed");
  expect(prompt).toContain("近期119原文。");
  expect(prompt).toContain("铜钥匙由老周保管。");
  expect(turn.contextReferences?.[0].source.id).toBe("remote8");
});

it("recovery: retries an empty response once and accounts for both requests", async () => {
  let calls = 0;
  const { app, projectId } = await setup((_body, res) => {
    reply(res, ++calls === 1 ? "" : { message: "开篇完成", chapters: [{ title: "开篇", content: "完整开篇。", stage: "opening" }] });
  });
  const turn = await done(app, await send(app, projectId, "先试写一段"));
  expect(turn.status).toBe("completed");
  expect(calls).toBe(2);
  expect(turn.usage.totalTokens).toBe(600);
  expect(turn.attempts).toHaveLength(2);
  expect(turn.attempts[0]).toMatchObject({ code: "EMPTY", usage: { totalTokens: 300 }, diagnostics: { receivedChars: 0 } });
  expect(app.snapshot().chapters.map(c => c.content)).toEqual(["完整开篇。"]);
});

it("recovery: stops after two empty responses with their reported usage intact", async () => {
  let calls = 0;
  const { app, projectId } = await setup((_body, res) => { calls++; reply(res, ""); });
  const turn = await done(app, await send(app, projectId, "先试写一段"));
  expect(calls).toBe(2);
  expect(turn.status).toBe("failed");
  expect(turn.usage.totalTokens).toBe(600);
  expect(turn.attempts).toHaveLength(2);
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("recovery: repairs the entire malformed response without losing its trailing material", async () => {
  const first = { message: "开篇完成", chapters: [{ title: "开篇", content: "需要保留的开篇。", stage: "opening" }] };
  const raw = JSON.stringify(first) + ',"memory":"尾部共识也要保留"}';
  let calls = 0, repairInput = "";
  const { app, projectId, dir } = await setup((body, res) => {
    calls++;
    if (calls === 1) return reply(res, raw);
    repairInput = JSON.stringify(body.messages);
    reply(res, { ...first, memory: "尾部共识也要保留" });
  });
  const turnId = await send(app, projectId, "先试写一段");
  const turn = await done(app, turnId);
  expect(turn.status).toBe("completed");
  expect(calls).toBe(2);
  expect(repairInput).toContain(JSON.stringify(raw).slice(1, -1));
  expect(turn.memory).toBe("尾部共识也要保留");
  expect(turn.usage.totalTokens).toBe(600);
  expect(turn.attempts[0].rawResponse).toBe(raw);
  expect(app.snapshot().chapters[0].content).toBe("需要保留的开篇。");
  const workspace = app.workspaceSnapshot(projectId).state!;
  expect(JSON.stringify(workspace.conversations)).not.toContain("需要保留的开篇");
  const store = new Store(join(dir, "works.sqlite"));
  expect(store.get("conversations", turnId)!.attempts![0].rawResponse).toBe(raw);
  const files = new ProjectFiles(store), archive = join(dir, "recovery.novel");
  await files.backup(projectId, archive);
  const importedId = await files.importBackup(archive);
  const restored = store.list("conversations").find(t => t.projectId === importedId)!;
  expect(restored.attempts![0].rawResponse).toBe(raw);
  expect(restored.usage?.totalTokens).toBe(600);
  store.close();
});

it("recovery: cannot turn a malformed draft into a successful empty or rewritten reply", async () => {
  let calls = 0;
  const raw = '{"message":"开篇完成","chapters":[{"title":"开篇","content":"原始候选正文。","stage":"opening"}],}';
  const { app, projectId } = await setup((_body, res) => reply(res, ++calls === 1 ? raw : { message: "开篇完成", chapters: [] }));
  const turn = await done(app, await send(app, projectId, "先试写一段"));
  expect(calls).toBe(2);
  expect(turn.status).toBe("failed");
  expect(turn.attempts[0].rawResponse).toBe(raw);
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("recovery: shares a three request ceiling across empty, format and network failures", async () => {
  let calls = 0;
  const { app, projectId } = await setup((_body, res) => {
    calls++;
    if (calls === 1) return reply(res, "");
    if (calls === 2) return reply(res, '{"message":"回复",}');
    res.writeHead(503); res.end("private upstream error");
  });
  const turn = await done(app, await send(app, projectId, "先试写一段"));
  expect(calls).toBe(3);
  expect(turn.status).toBe("failed");
  expect(turn.usage).toMatchObject({ totalTokens: 600, estimated: true });
  expect(turn.attempts).toHaveLength(3);
  expect(JSON.stringify(turn)).not.toContain("private upstream error");
});

it("recovery: cancellation while repairing prevents all chapter writes", async () => {
  let calls = 0, release: (() => void) | undefined;
  const { app, projectId } = await setup((_body, res) => {
    if (++calls === 1) return reply(res, '{"message":"开篇完成",}');
    release = () => reply(res, { message: "开篇完成", chapters: [{ title: "迟到", content: "不能落库", stage: "opening" }] });
  });
  const turnId = await send(app, projectId, "先试写一段");
  await expect.poll(() => calls).toBe(2);
  expect(app.snapshot().conversations.find(t => t.id === turnId)?.recoveryPhase).toBe("repairing");
  await app.dispatch({ type: "conversation.cancel", id: turnId });
  release?.();
  expect((await done(app, turnId)).status).toBe("cancelled");
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("recovery: rejects new prose inserted by a format repair", async () => {
  let calls = 0;
  const first = { message: "讨论即可" };
  const { app, projectId } = await setup((_body, res) => reply(res, ++calls === 1 ? '{"message":"讨论即可",}' : {
    ...first, chapters: [{ title: "新增", content: "修格式不该新写正文。", stage: "opening" }],
  }));
  const turn = await done(app, await send(app, projectId, "先试写一段"));
  expect(calls).toBe(2);
  expect(turn.status).toBe("failed");
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("recovery: rejects moving preserved text between chapter fields", async () => {
  let calls = 0;
  const first = { message: "开篇完成", chapters: [{ title: "原始标题", content: "原始正文。", stage: "opening" }] };
  const { app, projectId } = await setup((_body, res) => reply(res, ++calls === 1 ? JSON.stringify(first) + ',' : {
    message: first.message, chapters: [{ title: "原始正文。", content: "原始标题", stage: "opening" }],
  }));
  const turn = await done(app, await send(app, projectId, "先试写一段"));
  expect(calls).toBe(2);
  expect(turn.status).toBe("failed");
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("recovery: preserves the order of new chapters during format repair", async () => {
  let calls = 0;
  const chapters = [{ title: "开端", content: "第一章正文。", stage: "complete" }, { title: "结局", content: "第二章正文。", stage: "complete" }];
  const { app, projectId, dir } = await setup((_body, res) => reply(res, ++calls === 1 ? JSON.stringify({ message: "两章完成", chapters }) + ',' : { message: "两章完成", chapters: [...chapters].reverse() }));
  const turn = await done(app, legacySend(dir, projectId, "先写正文，连写2章"));
  expect(calls).toBe(2);
  expect(turn.status).toBe("failed");
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("recovery: author edits during a repair win over the late repaired draft", async () => {
  let calls = 0, release: (() => void) | undefined;
  const response = { message: "开篇完成", chapters: [{ title: "开篇", content: "候选正文。", stage: "opening" }] };
  const { app, projectId } = await setup((_body, res) => {
    if (++calls === 1) return reply(res, JSON.stringify(response) + ',');
    release = () => reply(res, response);
  });
  const turnId = await send(app, projectId, "先试写一段");
  await expect.poll(() => calls).toBe(2);
  const chapterId = id(await app.dispatch({ type: "chapter.create", projectId, ordinal: 1, title: "作者新建" }));
  id(await app.dispatch({ type: "chapter.save", id: chapterId, revision: 1, content: "作者正在写的正文。" }));
  release?.();
  const turn = await done(app, turnId);
  expect(turn.status).toBe("failed");
  expect(turn.error).toContain("发生变化");
  expect(app.snapshot().chapters.map(c => c.content)).toEqual(["作者正在写的正文。"]);
});

it("recovery: keeps an unreported empty attempt visible in the usage total", async () => {
  let calls = 0;
  const { app, projectId } = await setup((_body, res) => {
    if (++calls === 1) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "" } }] })); }
    else reply(res, { message: "现在有回复" });
  });
  const turn = await done(app, await send(app, projectId, "先讨论"));
  expect(turn.status).toBe("completed");
  expect(turn.usage).toMatchObject({ totalTokens: 300, estimated: true });
  expect(turn.attempts[0].usage.totalTokens).toBeNull();
});

it("recovery: records an overall deadline as timeout without retrying or writing", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let calls = 0;
  const { app, projectId } = await setup(() => { calls++; });
  const turnId = await send(app, projectId, "先试写一段");
  await expect.poll(() => calls).toBe(1);
  deadline.abort();
  const turn = await done(app, turnId);
  expect(turn.status).toBe("failed");
  expect(turn.error).toContain("时限");
  expect(turn.attempts[0].code).toBe("TIMEOUT");
  expect(calls).toBe(1);
  expect(app.snapshot().chapters).toHaveLength(0);
});

it("recovery: cancellation during retry delay prevents the next request", async () => {
  let calls = 0;
  const { app, projectId, dir } = await setup((_body, res) => { calls++; reply(res, ""); });
  const turnId = await send(app, projectId, "先试写一段");
  await expect.poll(() => app.conversation(turnId).recoveryPhase).toBe("retrying");
  await app.dispatch({ type: "conversation.cancel", id: turnId });
  await app.dispose();
  expect(calls).toBe(1);
  const store = new Store(join(dir, "works.sqlite"));
  expect(store.get("conversations", turnId)).toMatchObject({ status: "cancelled", usage: { totalTokens: 300 } });
  store.close();
});

it("recovery: retains limited output and usage without attempting format repair", async () => {
  let calls = 0;
  const { app, projectId } = await setup((_body, res) => {
    calls++;
    res.setHeader("Content-Type", "text/event-stream");
    res.end('data: {"choices":[{"delta":{"content":"半截候选正文"},"finish_reason":"length"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":200,"total_tokens":300}}\n\ndata: [DONE]\n\n');
  });
  const turn = await done(app, await send(app, projectId, "先试写一段"));
  expect(turn.status).toBe("failed");
  expect(turn.attempts[0]).toMatchObject({ code: "OUTPUT_LIMIT", rawResponse: "半截候选正文", usage: { totalTokens: 300 } });
  expect(calls).toBe(1);
  expect(app.snapshot().chapters).toHaveLength(0);
});

// Missing auto-application, current-draft context or chapter reuse breaks this real service workflow.
it("discusses, saves an opening and settings, then completes the same edited chapter across restart", async () => {
  let call = 0,
    chapterId = "";
  const { app, projectId, dir } = await setup((body, res) => {
    call++;
    if (call === 1)
      return reply(res, {
        message: "推荐写遗物整理师。",
        suggestions: ["按推荐，先写一段"],
        memory: "作者偏好悬疑",
      });
    if (call === 2)
      return reply(res, {
        message: "开篇已写好。",
        memory: "主角林舟，嘴贫的遗物整理师",
        project: { title: "自己的遗物", genre: "悬疑" },
        notes: [{ type: "character", title: "林舟", body: "嘴贫的遗物整理师" }],
        chapters: [
          { title: "包裹", content: "林舟收到自己的遗物。", stage: "opening" },
        ],
      });
    expect(JSON.stringify(body.messages)).toContain("作者亲手修改的开头");
    expect(JSON.stringify(body.messages)).toContain("主角林舟");
    reply(res, {
      message: "第一章完成。",
      memory: "第一章结束于来电",
      chapters: [
        {
          id: chapterId,
          title: "包裹",
          content: "作者亲手修改的开头。电话突然响了。",
          stage: "complete",
        },
      ],
    });
  });
  expect(
    (await done(app, await send(app, projectId, "我没有想法"))).reply,
  ).toContain("推荐");
  expect(app.snapshot().chapters).toHaveLength(0);
  await done(app, await send(app, projectId, "按推荐，先写一段"));
  const opening = app.snapshot().chapters[0];
  chapterId = opening.id;
  expect(opening.content).toBe("林舟收到自己的遗物。");
  expect(app.snapshot().notes[0].body).toBe("嘴贫的遗物整理师");
  id(
    await app.dispatch({
      type: "chapter.save",
      id: opening.id,
      revision: opening.revision,
      content: "作者亲手修改的开头。",
    }),
  );
  await app.dispose();
  const reopened = new AppServices({
    dataDir: dir,
    dialogs: { open: async () => null, save: async () => null },
  });
  apps.push(reopened);
  expect((reopened.snapshot() as any).conversations).toHaveLength(2);
  const turn = await done(reopened, await send(reopened, projectId, "继续完成这一章"));
  expect(turn.status).toBe("completed");
  expect(reopened.snapshot().chapters).toHaveLength(1);
  expect(reopened.snapshot().chapters[0].content).toContain("电话突然响了");
  expect(
    reopened
      .snapshot()
      .versions.some((v) => v.content === "作者亲手修改的开头。"),
  ).toBe(true);
  const openingVersion = reopened
    .snapshot()
    .versions.find((v) => v.content === "林舟收到自己的遗物。");
  const current = reopened.snapshot().chapters[0];
  id(
    await reopened.dispatch({
      type: "chapter.restore",
      id: current.id,
      revision: current.revision,
      versionId: openingVersion!.id,
    }),
  );
  expect(reopened.snapshot().chapters[0].writingStage).toBe("opening");
});

it("rejects stale responses without overwriting author edits or partially applying settings", async () => {
  let release!: () => void;
  const { app, projectId } = await setup((_body, res) => {
    release = () =>
      reply(res, {
        message: "改好了",
        project: { title: "不应更新" },
        chapters: [
          {
            id: chapter.id,
            title: "改写",
            content: "迟到的AI正文",
            stage: "complete",
          },
        ],
      });
  });
  const chapterId = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "旧章",
    }),
  );
  const chapter = app.snapshot().chapters[0];
  const turnId = await send(app, projectId, "改写这一章");
  await expect.poll(() => !!release).toBe(true);
  id(
    await app.dispatch({
      type: "chapter.save",
      id: chapterId,
      revision: chapter.revision,
      content: "正在写的手稿",
    }),
  );
  release();
  const turn = await done(app, turnId);
  expect(turn.status).toBe("failed");
  expect(turn.error).toMatch(/修改|变化/);
  expect(app.snapshot().chapters[0].content).toBe("正在写的手稿");
  expect(app.snapshot().projects[0].title).toBe("未命名故事");
});

it("asks before changing earlier chapters and applies a confirmed proposal through ordinary conversation", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "需要回改两章中的职业描写。",
      memory: "职业改为调查员",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "保险调查员正在调查。",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    const c = id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `第${ordinal}章`,
      }),
    );
    id(
      await app.dispatch({
        type: "chapter.save",
        id: c,
        revision: 1,
        content: "遗物整理师正在工作。",
      }),
    );
  }
  chapters = app.snapshot().chapters;
  const proposal = await done(
    app,
    await send(app, projectId, "把主角改成保险调查员"),
  );
  expect(proposal.status).toBe("awaiting-author");
  expect(proposal.proposal.chapterIds).toHaveLength(2);
  expect(
    app.snapshot().chapters.every((c) => c.content.includes("遗物整理师")),
  ).toBe(true);
  const accepted = await done(app, await send(app, projectId, "一起改"));
  expect(accepted.status).toBe("completed");
  expect(
    app.snapshot().chapters.every((c) => c.content.includes("保险调查员")),
  ).toBe(true);
});

it("honors an explicit multi-chapter scope and saves reviewable candidates before adoption", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((body, res) =>
    reply(res, {
      message: "改好了",
      chapters: [JSON.parse(body.messages.at(-1).content).chapter].map((c) => ({
        id: c.id,
        title: c.title,
        content: "重写正文",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  const jobId = await send(app, projectId, "把前两章一起改成轻松一点");
  await expect.poll(() => app.snapshot().revisionJobs!.find(j => j.id === jobId)?.status).toBe("awaiting-author");
  expect(app.snapshot().revisionJobs!.find(j => j.id === jobId)!.candidates).toHaveLength(2);
  expect(app.snapshot().chapters.every(c => c.content === "")).toBe(true);
  id(await app.dispatch({ type: "revision.accept", id: jobId }));
  expect(app.snapshot().chapters.every((c) => c.content === "重写正文")).toBe(
    true,
  );
});

it("cancels, retries and never applies a cancelled late response", async () => {
  let release!: () => void,
    call = 0;
  const { app, projectId } = await setup((_body, res) => {
    if (++call === 1)
      release = () =>
        reply(res, {
          message: "迟到",
          chapters: [{ title: "旧", content: "取消的内容", stage: "opening" }],
        });
    else
      reply(res, {
        message: "重试成功",
        chapters: [{ title: "新", content: "重试的正文", stage: "opening" }],
      });
  });
  const turnId = await send(app, projectId, "试写开头");
  await expect.poll(() => !!release).toBe(true);
  id(
    await app.dispatch({ type: "conversation.cancel", id: turnId } as Command),
  );
  release();
  expect((await done(app, turnId)).status).toBe("cancelled");
  expect(app.snapshot().chapters).toHaveLength(0);
  const retryId = id(
    await app.dispatch({ type: "conversation.retry", id: turnId } as Command),
  );
  expect((await done(app, retryId)).status).toBe("completed");
  expect(app.snapshot().chapters[0].content).toBe("重试的正文");
});

it("does not apply malformed, foreign or excessive default chapter operations", async () => {
  let output: any = "不是JSON";
  const { app, projectId } = await setup((_body, res) => reply(res, output));
  expect((await done(app, await send(app, projectId, "试写"))).status).toBe(
    "failed",
  );
  output = {
    message: "结果",
    project: { title: "不应保存" },
    chapters: [
      { id: "another-book", title: "章", content: "正文", stage: "complete" },
    ],
  };
  expect((await done(app, await send(app, projectId, "继续"))).status).toBe(
    "failed",
  );
  output = {
    message: "结果",
    chapters: [1, 2].map((n) => ({
      title: `章${n}`,
      content: "正文",
      stage: "complete",
    })),
  };
  expect((await done(app, await send(app, projectId, "继续"))).status).toBe(
    "failed",
  );
  expect(app.snapshot().chapters).toHaveLength(0);
  expect(app.snapshot().projects[0].title).toBe("未命名故事");
});

it("keeps a failed foreign response from poisoning portable backups", async () => {
  const { app, projectId, dir } = await setup((_body, res) =>
    reply(res, {
      message: "无效引用",
      chapters: [
        {
          id: "foreign-book-chapter",
          title: "章",
          content: "正文",
          stage: "complete",
        },
      ],
    }),
  );
  expect((await done(app, await send(app, projectId, "重写"))).status).toBe(
    "failed",
  );
  await app.dispose();
  const store = new Store(join(dir, "works.sqlite"));
  try {
    const files = new ProjectFiles(store),
      path = join(dir, "backup.novel");
    await files.backup(projectId, path);
    await expect(files.importBackup(path)).resolves.toBeTruthy();
  } finally {
    store.close();
  }
});

it("retrying an authorized rewrite retains the concrete approved scope", async () => {
  let call = 0,
    chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) => {
    call++;
    if (call === 2) return reply(res, "malformed JSON");
    reply(res, {
      message: "调整职业",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "调查员",
        stage: "complete",
      })),
    });
  });
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (await done(app, await send(app, projectId, "把主角改成调查员"))).status,
  ).toBe("awaiting-author");
  const failed = await done(app, await send(app, projectId, "一起改"));
  expect(failed.status).toBe("failed");
  const retryId = id(
    await app.dispatch({
      type: "conversation.retry",
      id: failed.id,
    } as Command),
  );
  expect((await done(app, retryId)).status).toBe("completed");
  expect(app.snapshot().chapters.every((c) => c.content === "调查员")).toBe(
    true,
  );
});

it("keeps each completed chapter available when a model includes an already authorized proposal", async () => {
  let target = "";
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "改写完成",
      proposal: { chapterIds: [target], reason: "改写当前章" },
      chapters: [
        { id: target, title: "章", content: "新正文", stage: "complete" },
      ],
    }),
  );
  target = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "章",
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "重写当前章"))).status,
  ).toBe("completed");
  expect(app.snapshot().chapters[0].content).toBe("新正文");
});

it("never adds the selected chapter to an explicitly narrower rewrite scope", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "改写",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "改后",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (
      await done(
        app,
        await send(app, projectId, "只重写第1章", {
          chapterId: chapters[1].id,
        }),
      )
    ).status,
  ).toBe("awaiting-author");
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("does not let an in-scope proposal hide out-of-scope chapter edits", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "改写",
      proposal: { chapterIds: [chapters[1].id], reason: "改当前章" },
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "改后",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  expect(
    (await done(app, await send(app, projectId, "重写当前章"))).status,
  ).toBe("awaiting-author");
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("does not replace an existing note whose full text could not fit", async () => {
  let noteId = "";
  const { app, projectId } = await setup(
    (_body, res) =>
      reply(res, {
        message: "整理人物",
        notes: [
          {
            id: noteId,
            type: "character",
            title: "人物",
            body: "过短且丢失后半设定的替换",
          },
        ],
      }),
    { maxContextChars: 2000 },
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "人物",
      body: "甲".repeat(10000),
      sources: [],
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "整理人物设定"))).status,
  ).toBe("failed");
  expect(app.snapshot().notes[0].body.length).toBe(10000);
});

it("keeps historic note references portable after the author deletes a note", async () => {
  let noteId = "";
  const { app, projectId, dir } = await setup((_body, res) =>
    reply(res, {
      message: "整理人物",
      notes: [{ id: noteId, type: "character", title: "人物", body: "新设定" }],
    }),
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "人物",
      body: "原设定",
      sources: [],
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "整理人物设定"))).status,
  ).toBe("completed");
  id(
    await app.dispatch({
      type: "note.delete",
      id: noteId,
      revision: app.snapshot().notes[0].revision,
    }),
  );
  await app.dispose();
  const store = new Store(join(dir, "works.sqlite"));
  try {
    const files = new ProjectFiles(store),
      path = join(dir, "deleted-note.novel");
    await files.backup(projectId, path);
    await expect(files.importBackup(path)).resolves.toBeTruthy();
  } finally {
    store.close();
  }
});

it("retains prior setting text when AI updates it, and restoration retains the AI version", async () => {
  let noteId = "";
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "已更新职业",
      notes: [
        {
          id: noteId,
          type: "character",
          title: "林舟",
          body: "保险调查员，怕黑",
        },
      ],
    }),
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "林舟",
      body: "遗物整理师，怕黑",
      sources: [],
    }),
  );
  expect(
    (await done(app, await send(app, projectId, "把主角改成调查员"))).status,
  ).toBe("completed");
  const note = app.snapshot().notes[0];
  expect((note as any).history?.[0].body).toBe("遗物整理师，怕黑");
  id(
    await app.dispatch({
      type: "note.save",
      id: note.id,
      revision: note.revision,
      projectId,
      noteType: "character",
      title: "林舟",
      body: "遗物整理师，怕黑",
      sources: [],
    }),
  );
  expect((app.snapshot().notes[0] as any).history?.at(-1).body).toBe(
    "保险调查员，怕黑",
  );
});

it("infers a missing rewrite id from the explicit target instead of a different selected opening", async () => {
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "重写第一章",
      chapters: [{ title: "第一章", content: "新的第一章", stage: "complete" }],
    }),
  );
  const first = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "第一章",
    }),
  );
  const second = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 2,
      title: "第二章",
    }),
  );
  const store = new Store(join(dirs.at(-1)!, "works.sqlite"));
  try {
    const c = store.get("chapters", second)!;
    store.put("chapters", {
      ...c,
      content: "保留第二章开篇",
      writingStage: "opening",
    });
  } finally {
    store.close();
  }
  expect(
    (
      await done(
        app,
        await send(app, projectId, "只重写第1章", { chapterId: second }),
      )
    ).status,
  ).toBe("completed");
  expect(app.snapshot().chapters.find((c) => c.id === first)!.content).toBe(
    "新的第一章",
  );
  expect(app.snapshot().chapters.find((c) => c.id === second)!.content).toBe(
    "保留第二章开篇",
  );
});

it("subtracts explicit excluded chapters from broader rewrite ranges", async () => {
  let chapters: any[] = [];
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "重写",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "不该全部改",
        stage: "complete",
      })),
    }),
  );
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  const jobId = await send(app, projectId, "改全部章节，但别改第1章");
  await expect.poll(() => app.snapshot().revisionJobs!.find(j => j.id === jobId)?.status).not.toBe("running");
  const job = app.snapshot().revisionJobs!.find(j => j.id === jobId)!;
  expect(job.chapterIds).toEqual([chapters[1].id]);
  // The fixture deliberately returns the excluded chapter too; reject the whole output.
  expect(job.status).toBe("failed");
  expect(job.candidates).toEqual([]);
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("does not invalidate manuscript or accumulate setting versions for unchanged model fields", async () => {
  let noteId = "";
  const { app, projectId } = await setup((_body, res) =>
    reply(res, {
      message: "我们再聊聊",
      project: { background: "" },
      notes: [{ id: noteId, type: "character", title: "人物", body: "原设定" }],
    }),
  );
  noteId = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "人物",
      body: "原设定",
      sources: [],
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "章",
    }),
  );
  const before = app.snapshot();
  expect((await done(app, await send(app, projectId, "聊聊故事"))).status).toBe(
    "completed",
  );
  expect(app.snapshot().projects).toEqual(before.projects);
  expect(app.snapshot().notes).toEqual(before.notes);
  expect(app.snapshot().chapters).toEqual(before.chapters);
});

it("accepting a one-chapter proposal does not also authorize the selected chapter", async () => {
  let chapters: any[] = [],
    calls = 0;
  const { app, projectId } = await setup((_body, res) => {
    if (++calls === 1)
      return reply(res, {
        message: "只需改第一章",
        proposal: {
          chapterIds: [chapters[0].id],
          reason: "第一章职业描写需要调整",
        },
      });
    reply(res, {
      message: "改写",
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        content: "模型越界改写",
        stage: "complete",
      })),
    });
  });
  for (let ordinal = 1; ordinal <= 2; ordinal++)
    id(
      await app.dispatch({
        type: "chapter.create",
        projectId,
        ordinal,
        title: `章${ordinal}`,
      }),
    );
  chapters = app.snapshot().chapters;
  const proposal = await done(app, await send(app, projectId, "调整职业"));
  expect(proposal.proposal.chapterIds).toEqual([chapters[0].id]);
  expect(
    (
      await done(
        app,
        await send(app, projectId, "一起改", { proposalTurnId: proposal.id }),
      )
    ).status,
  ).toBe("awaiting-author");
  expect(app.snapshot().chapters.every((c) => c.content === "")).toBe(true);
});

it("legacy runner accepts a three-chapter response and still prevents simultaneous turns", async () => {
  let release!: () => void;
  const { app, projectId, dir } = await setup((_body, res) => {
    release = () =>
      reply(res, {
        message: "三章已写好",
        chapters: [1, 2, 3].map((n) => ({
          title: `章${n}`,
          content: `第${n}章正文`,
          stage: "complete",
        })),
      });
  });
  const turnId = legacySend(dir, projectId, "连写三章");
  expect(
    await app.dispatch({
      type: "conversation.send",
      projectId,
      text: "继续",
    } as Command),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  await expect.poll(() => !!release).toBe(true);
  release();
  expect((await done(app, turnId)).status).toBe("completed");
  expect(app.snapshot().chapters.map((c) => c.ordinal)).toEqual([1, 2, 3]);
});

it("discloses omitted long context and refuses to rewrite an incompletely supplied chapter", async () => {
  let target = "";
  const { app, projectId } = await setup(
    (_body, res) =>
      reply(res, {
        message: "重写",
        chapters: [
          { id: target, title: "长章", content: "不应替换", stage: "complete" },
        ],
      }),
    { maxContextChars: 2000 },
  );
  target = id(
    await app.dispatch({
      type: "chapter.create",
      projectId,
      ordinal: 1,
      title: "长章",
    }),
  );
  id(
    await app.dispatch({
      type: "chapter.save",
      id: target,
      revision: 1,
      content: "甲".repeat(10000),
    }),
  );
  const turn = await done(app, await send(app, projectId, "重写当前章"));
  expect(turn.status).toBe("failed");
  expect(turn.contextWarnings.length).toBeGreaterThan(0);
  expect(app.snapshot().chapters[0].content.length).toBe(10000);
});
