import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { AppServices } from "../src/main/services";
import type { Command, CommandResult } from "../src/shared/types";

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
it("keeps incomplete length after exactly two revisions visibly pending review", async () => {
  const { app, projectId, calls } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·生成") || phase.includes("连续写作·修订")) { reply(res, { title: `第${input.ordinal}章`, content: "太短的稿子。", majorChange: false, reason: "" }); return true; }
  });
  const job = await done(app, await start(app, projectId, "写完前二章"));
  expect(job.status).toBe("awaiting-author");
  expect(job.chapters.map(c => c.revisionRounds)).toEqual([2, 2]);
  expect(calls.filter(c => c.phase.includes("连续写作·修订"))).toHaveLength(4);
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
it("local style issues can continue after two revisions but cannot become an all-clear", async () => {
  const { app, projectId } = await setup((phase, input, res) => {
    if (phase.includes("连续写作·检查") || phase.includes("连续写作·跨章复核")) {
      const source = lastChapter(input);
      reply(res, { issues: [{ category: "style", impact: "local", reason: "同一句话反复出现，行文单调", evidence: [{ quote: "雨落在窗前。", source }] }], majorChange: false, reason: "" }); return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前二章"));
  expect(job.status).toBe("awaiting-author");
  expect(job.chapters.map(c => c.revisionRounds)).toEqual([2, 2]);
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
      reply(res, { issues: [{ category: "style", impact: "local", reason: "重复句式", evidence: [{ quote: "雨落在窗前。", source }] }], majorChange: false, reason: "" }); return true;
    }
    if (invalid && phase.includes("连续写作·检查")) {
      invalid = false;
      const source = { ...lastChapter(input), revision: 999 };
      reply(res, { issues: [{ category: "style", impact: "local", reason: "重复句式", evidence: [{ quote: "雨落在窗前。", source }] }], majorChange: false, reason: "" }); return true;
    }
  });
  const job = await done(app, await start(app, projectId, "写完前一章"));
  expect(job.status, job.reply).toBe("completed");
  expect(repairs).toBe(1);
  expect(job.chapters[0].revisionRounds).toBe(1);
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
  expect(job.chapters[0].revisionRounds).toBe(1);
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
