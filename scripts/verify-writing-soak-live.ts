// Run only against a disposable, consistent backup; keep private responses there.
import { app, safeStorage } from "electron";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AppServices } from "../src/main/services";
const directory = process.env.NOVEL_SOAK_DIR!;
if (!directory || !basename(directory).startsWith("novel-writing-soak-")) throw Error("需要隔离验证目录");
app.setName("小说工坊"); app.setPath("userData", directory);
let services: AppServices | undefined, calls = 0, replayed = 0;
const run = process.env.NOVEL_SOAK_RUN || String(Date.now());
const evidence: any = { run, isolated: true, productionModified: false, responses: [] };
void app.whenReady().then(async () => {
  try {
    services = new AppServices({ dataDir: directory, credentials: { encrypt: x => safeStorage.encryptString(x), decrypt: x => safeStorage.decryptString(Buffer.from(x)) },
      dialogs: { open: async () => null, save: async () => null }, provider: { timeoutMs: 150000 }, fetch: async (url, init) => {
        if (calls >= 24) throw Error("单轮验证请求上限");
        const number = ++calls, body = JSON.parse(String(init?.body)), phase = body.messages[0].content.split("。")[0];
        console.log(JSON.stringify({ event: "request", number, phase }));
        const fixture = number === 1 && process.env.NOVEL_SOAK_REPLAY_FILE
          ? JSON.parse(readFileSync(process.env.NOVEL_SOAK_REPLAY_FILE, "utf8").trim().split("\n").at(-1)!) : undefined;
        if (fixture && fixture.phase !== phase) throw Error("重放阶段不匹配");
        if (fixture) replayed++;
        const response = fixture ? new Response(JSON.stringify({choices:[{message:{content:fixture.content},finish_reason:"stop"}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}),{headers:{"content-type":"application/json"}}) : await fetch(url, init), raw = await response.clone().text();
        let content = "", usage: any;
        for (const line of raw.split("\n")) if (line.startsWith("data:")) { try { const e = JSON.parse(line.slice(5)); content += e.choices?.[0]?.delta?.content ?? ""; if (e.usage) usage = e.usage; } catch {} }
        if (!content) { try { const e = JSON.parse(raw); content = e.choices?.[0]?.message?.content ?? ""; usage = e.usage; } catch {} }
        appendFileSync(join(directory, `${run}-private.jsonl`), JSON.stringify({ number, phase, body, content }) + "\n", { mode: 0o600 });
        let shape: any;
        try { const v = JSON.parse(content); shape = { keys: Object.keys(v), issues: v.issues?.map((i: any) => ({ category: i.category, impact: i.impact, evidence: i.evidence?.length })) }; } catch { shape = "not-json"; }
        const meta = { number, phase, characters: content.length, shape, usage }; evidence.responses.push(meta); console.log(JSON.stringify({ event: "response", ...meta }));
        return response;
      } });
    const existing = services.snapshot().writingJobs!.filter(j => j.createdAt >= "2026-10-16").at(-1)!;
    if (!existing) throw Error("缺少待验证任务");
    evidence.startCalls = existing.calls; evidence.startBudgetUsed = existing.budgetUsed;
    if (process.env.NOVEL_SOAK_RECHECK_FILE) {
      const previous = JSON.parse(readFileSync(process.env.NOVEL_SOAK_RECHECK_FILE, "utf8").trim().split("\n").at(-1)!);
      const runner = (services as any).writing, store = (services as any).store;
      store.put("writingJobs", { ...existing, status: "running", tokenBudget: existing.budgetUsed + 100000 });
      try {
        const raw = await runner.call(existing.id, "独立复核", { ...JSON.parse(previous.body.messages[1].content), suspectedReview: previous.content },
          previous.body.messages[0].content + "\n独立复核上次疑点，不预设上次结论正确。逐项核对同一时间、同一对象和互斥事实，特别区分不同人物、推测、正常时间推进与前后日期。仅保留原文明确支持的真实矛盾；撤回误报必须在顶层reason说明依据，即使majorChange=false也填写原因。不得为了完成任务而撤回真实矛盾。输出同一issues/majorChange/reason结构。", 3000, new AbortController().signal, true);
        const value = JSON.parse(raw); evidence.recheck = { issues: value.issues?.map((i:any)=>({category:i.category,impact:i.impact})), majorChange:value.majorChange, hasExplanation:!!value.reason };
      } finally { const latest = store.get("writingJobs", existing.id); store.put("writingJobs", { ...latest, status: existing.status }); }
      return;
    }
    let jobId = existing.id;
    const result = process.env.NOVEL_SOAK_APPEND === "1"
      ? await services.dispatch({ type: "conversation.send", projectId: existing.projectId, text: "接着写4章，每章大约3000字", tokenBudget: 400000 })
      : await services.dispatch({ type: "writing.resume", id: existing.id, tokenBudget: existing.budgetUsed + 400000,
          ...(process.env.NOVEL_SOAK_DECISION ? { text: process.env.NOVEL_SOAK_DECISION } : {}) });
    if (!result.ok) throw Error(result.error.message); jobId = result.entityId;
    const deadline = Date.now() + 12 * 60 * 1000; let previous = "";
    while (true) {
      const j = services.snapshot().writingJobs!.find(j => j.id === jobId)!;
      const progress = JSON.stringify({ status: j.status, phase: j.phase, cursor: j.cursor, saved: j.chapters.filter(c => c.chapterId).length });
      if (progress !== previous) { previous = progress; console.log(progress); }
      if (j.status !== "running") break;
      if (Date.now() > deadline) { await services.dispatch({ type: "writing.pause", id: jobId }); break; }
      await new Promise(r => setTimeout(r, 500));
    }
    const j = services.snapshot().writingJobs!.find(j => j.id === jobId)!;
    evidence.result = { status: j.status, phase: j.phase, error: j.error, calls: j.calls, usage: j.usage, budgetUsed: j.budgetUsed,
      chapters: j.chapters.map(c => ({ ordinal: c.ordinal, status: c.status, revisionRounds: c.revisionRounds, words: c.chapterId ? services!.chapter(c.chapterId).content.replace(/\s/g, "").length : 0 })),
      issues: j.issues.map(i => ({ category: i.category, impact: i.impact })), warningCount: j.warnings.length };
    evidence.workflowCompleted = j.phase === "done" && j.chapters.every(c => ["checked", "needs-review"].includes(c.status));
    if (!evidence.workflowCompleted) process.exitCode = 1;
  } catch (e) { evidence.error = e instanceof Error ? e.message : "验证失败"; process.exitCode = 1; }
  finally { evidence.liveCalls = calls - replayed; evidence.replayedResponses = replayed; await services?.dispose(); writeFileSync(resolve(`docs/writing-soak-${run}.json`), JSON.stringify(evidence, null, 2) + "\n"); app.quit(); }
});
