import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServices } from "../src/main/services";
import type { TaskRecord, Command, CommandResult } from "../src/shared/types";
import { validateTask } from "../src/shared/validation";
const apps: AppServices[] = [],
  servers: Server[] = [],
  dirs: string[] = [];
afterEach(async () => {
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
async function fixture(handler: (res: ServerResponse, body: any) => void) {
  const s = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    handler(res, JSON.parse(raw));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as any).port}/v1`;
}
function reply(res: ServerResponse, text: string, total = 30) {
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: total },
    }),
  );
}
function ok(r: CommandResult) {
  expect(r.ok).toBe(true);
  if (!r.ok) throw Error(r.error.message);
  return r.entityId;
}
function setup(extra: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "novel-tasks-"));
  dirs.push(dir);
  const app = new AppServices({
    dataDir: dir,
    credentials: {
      encrypt: (s: string) => Buffer.from("protected-" + s),
      decrypt: (b: Uint8Array) => Buffer.from(b).toString().slice(10),
    },
    dialogs: { open: async () => null, save: async () => null },
    provider: { retryDelayMs: 1 },
    ...extra,
  });
  apps.push(app);
  const projectId = extra.noProject
    ? ""
    : ok(
        app.domain.execute({
          type: "project.create",
          title: "小说",
          chapterWords: 100,
        }),
      );
  return { app, dir, projectId };
}
function model(
  app: AppServices,
  url: string,
  purpose: "writing" | "planning" | "checking" = "writing",
) {
  return ok(
    app.domain.execute({
      type: "profile.save",
      name: "测试模型",
      baseUrl: url,
      model: "fixture",
      purpose,
      apiKey: "DO-NOT-LEAK",
    }),
  );
}
function chapters(app: AppServices, p: string, count: number) {
  return Array.from({ length: count }, (_, i) =>
    ok(
      app.domain.execute({
        type: "chapter.create",
        projectId: p,
        ordinal: i + 1,
        title: `第${i + 1}章`,
      }),
    ),
  );
}
async function finish(app: AppServices, id: string): Promise<TaskRecord> {
  for (let i = 0; i < 200; i++) {
    const t = app.snapshot().tasks.find((t) => t.id === id)!;
    if (t && !["running", "waiting"].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("task timeout");
}
describe("author-controlled orchestration", () => {
  it("round-trips partial segmented coverage and resumes with remapped evidence", async () => {
    let selected: string | null = null;
    let backup = "";
    const { app, projectId, dir } = setup({ maxContextChars: 2000, dialogs: { open: async () => selected, save: async () => backup } });
    backup = join(dir, "segmented.novel");
    const noteId = ok(app.domain.execute({ type: "note.save", projectId, noteType: "world", title: "分段设定", body: "同日27岁又18岁。" + "甲".repeat(8000), sources: [] }));
    let calls = 0;
    const url = await fixture((res, body) => {
      if (++calls === 3) return;
      const sourceId = body.messages[1].content.match(/\[note:([^@]+)@1\]/)?.[1] ?? noteId;
      reply(res, JSON.stringify({ issues: body.messages[1].content.includes("同日27岁又18岁。") ? [{
        type: "character", reason: "年龄矛盾", evidence: [{ quote: "同日27岁又18岁。", source: { kind: "note", id: sourceId, revision: 1 } }],
      }] : [], majorChange: false }));
    });
    const taskId = ok(await app.dispatch({ type: "ai.check", projectId, profileId: model(app, url), tokenBudget: 100000 }));
    for (let i = 0; i < 200 && calls < 3; i++) await new Promise(r => setTimeout(r, 5));
    expect(calls).toBe(3);
    ok(await app.dispatch({ type: "task.cancel", id: taskId }));
    const task = await finish(app, taskId);
    expect((task.result as any).checkProgress.completed).toBe(1);
    expect((task.result as any).checkProgress.checked.issues).toHaveLength(1);
    ok(await app.dispatch({ type: "file.backup", projectId }));
    selected = backup;
    const importedId = ok(await app.dispatch({ type: "file.importBackup" }));
    const imported = app.snapshot().tasks.find(t => t.projectId === importedId)!;
    expect(() => validateTask(imported)).not.toThrow();
    const progress = (imported.result as any).checkProgress;
    expect(progress.completed).toBe(1);
    expect(progress.checked.issues[0].evidence[0].source.id).not.toBe(noteId);
    expect(progress.checked.issues[0].evidence[0].quote).toBe("同日27岁又18岁。");
    ok(await app.dispatch({ type: "task.resume", id: imported.id, mode: "continue" }));
    const completed = await finish(app, imported.id);
    expect(completed.status).toBe("awaiting-author");
    expect((completed.result as any).checkProgress.completed).toBe(progress.total);
    expect((completed.result as any).check.issues).toHaveLength(1);
    expect(() => validateTask(completed)).not.toThrow();
  });
  it("resumes cancelled segmented checks after restart without repeating completed windows", async () => {
    const { app, projectId, dir } = setup({ maxContextChars: 2000 });
    ok(app.domain.execute({ type: "note.save", projectId, noteType: "world", title: "分段设定", body: "甲".repeat(8000) + "尾部事实", sources: [] }));
    const prompts: string[] = [];
    let stalled = false;
    const url = await fixture((res, body) => {
      prompts.push(body.messages[1].content);
      if (prompts.length === 3) { stalled = true; return; }
      reply(res, JSON.stringify({ issues: [], majorChange: false }));
    });
    const taskId = ok(await app.dispatch({ type: "ai.check", projectId, profileId: model(app, url), tokenBudget: 100000 }));
    for (let i = 0; i < 200 && !stalled; i++) await new Promise(r => setTimeout(r, 5));
    expect(stalled).toBe(true);
    ok(await app.dispatch({ type: "task.cancel", id: taskId }));
    const cancelled = await finish(app, taskId);
    expect((cancelled.result as any).checkProgress.completed).toBe(1);
    await app.dispose();
    const reopened = new AppServices({ dataDir: dir, maxContextChars: 2000, dialogs: { open: async () => null, save: async () => null }, credentials: { encrypt: s => Buffer.from("protected-" + s), decrypt: b => Buffer.from(b).toString().slice(10) } });
    apps.push(reopened);
    ok(await reopened.dispatch({ type: "task.resume", id: taskId, mode: "continue" }));
    const completed = await finish(reopened, taskId);
    expect(completed.status).toBe("completed");
    expect(prompts.filter(p => p === prompts[0])).toHaveLength(2);
    expect(prompts.some(p => p.includes("尾部事实"))).toBe(true);
    expect(() => validateTask(completed)).not.toThrow();
    const corrupt = structuredClone(completed) as any;
    corrupt.result.checkProgress.completed = corrupt.result.checkProgress.total + 1;
    expect(() => validateTask(corrupt)).toThrow();
  });
  it("keeps partial coverage and findings when a segmented check exhausts its budget", async () => {
    const { app, projectId } = setup({ maxContextChars: 2000 });
    const noteId = ok(app.domain.execute({ type: "note.save", projectId, noteType: "world", title: "分段设定", body: "林舟27岁。同一天他18岁。" + "甲".repeat(8000), sources: [] }));
    const url = await fixture((res, body) => reply(res, JSON.stringify({ issues: body.messages[1].content.includes("林舟27岁。同一天他18岁。") ? [{
      type: "character", reason: "同日年龄矛盾", evidence: [{ quote: "林舟27岁。同一天他18岁。", source: { kind: "note", id: noteId, revision: 1 } }],
    }] : [], majorChange: false }), 2000));
    const task = await finish(app, ok(await app.dispatch({ type: "ai.check", projectId, profileId: model(app, url), tokenBudget: 6000 })));
    expect(task.status).toBe("awaiting-author");
    expect(task.error).toContain("预算");
    const progress = (task.result as any).checkProgress;
    expect(progress.completed).toBe(1);
    expect(progress.completed).toBeLessThan(progress.total);
    expect(progress.checked.issues).toHaveLength(1);
    expect((task.result as any).check).toBeUndefined();
    expect(() => validateTask(task)).not.toThrow();
  });
  it("checks every chapter ending in a twenty-chapter novel and persists coverage", async () => {
    const { app, projectId } = setup();
    const chapterIds = chapters(app, projectId, 20);
    chapterIds.forEach((id, i) => {
      ok(app.domain.execute({ type: "chapter.save", id, revision: app.snapshot().chapters.find(c => c.id === id)!.revision, content: "甲".repeat(2990) + `章末标记${i}。` + (i === 19 ? "林舟27岁。同一天他18岁。" : "") }));
      ok(app.domain.execute({ type: "chapter.confirm", id, revision: app.snapshot().chapters.find(c => c.id === id)!.revision }));
    });
    const prompts: string[] = [];
    const url = await fixture((res, body) => {
      const prompt = body.messages[1].content;
      prompts.push(prompt);
      reply(res, JSON.stringify({ issues: prompt.includes("林舟27岁。同一天他18岁。") ? [{
        type: "character", reason: "同日年龄矛盾", evidence: [{ quote: "林舟27岁。同一天他18岁。", source: { kind: "chapter", id: chapterIds[19], revision: app.snapshot().chapters.find(c => c.id === chapterIds[19])!.revision } }],
      }] : [], majorChange: false }));
    });
    const task = await finish(app, ok(await app.dispatch({ type: "ai.check", projectId, profileId: model(app, url), tokenBudget: 500000 })));
    expect(task.status).toBe("awaiting-author");
    for (let i = 0; i < 20; i++) expect(prompts.some(p => p.includes(`章末标记${i}。`))).toBe(true);
    expect(prompts.every(p => p.length <= 24000)).toBe(true);
    expect(app.snapshot().issues).toHaveLength(1);
    const progress = (task.result as any).checkProgress;
    expect(progress.completed).toBe(progress.total);
    expect(progress.total).toBeGreaterThan(1);
  });
  it("retains the end of a 300000-character setting in a check snapshot", async () => {
    const { app, projectId } = setup();
    ok(app.domain.execute({ type: "note.save", projectId, noteType: "outline", title: "长规划", body: "甲".repeat(299980) + "规划末尾不可遗漏", sources: [] }));
    const prompts: string[] = [];
    const url = await fixture((res, body) => {
      prompts.push(body.messages[1].content);
      reply(res, JSON.stringify({ issues: [], majorChange: false }));
    });
    const task = await finish(app, ok(await app.dispatch({ type: "ai.check", projectId, profileId: model(app, url), tokenBudget: 1000000 })));
    expect(task.status).toBe("completed");
    expect(prompts.some(p => p.includes("规划末尾不可遗漏"))).toBe(true);
    expect((task.requestSnapshot as any).context.documents.find((d: any) => d.source.kind === "note").text).toContain("规划末尾不可遗漏");
  });
  it.each(["fence", "trailing comma"])("accepts a syntax-only repair of an empty check and still reviews it: %s", async (format) => {
    const { app, projectId } = setup();
    let calls = 0;
    const clean = JSON.stringify({ issues: [], majorChange: false });
    const original = format === "fence" ? `\`\`\`json\n${clean}\n\`\`\`` : '{"issues":[],"majorChange":false,}';
    const url = await fixture((res) => reply(res, ++calls === 1 ? original : clean));
    const task = await finish(app, ok(await app.dispatch({
      type: "ai.check", projectId, profileId: model(app, url), tokenBudget: 20000,
    })));
    expect(task.status).toBe("completed");
    expect(task.calls).toBe(3);
  });
  it("does not clear invalid evidence through an empty format repair", async () => {
    const { app, projectId } = setup();
    let calls = 0;
    const url = await fixture((res) => reply(res, JSON.stringify(++calls === 1 ? {
      issues: [{ type: "world", reason: "无效引用", evidence: [{ quote: "不存在的原文", source: { kind: "project", id: projectId, revision: 1 } }] }], majorChange: false,
    } : { issues: [], majorChange: false })));
    const task = await finish(app, ok(await app.dispatch({
      type: "ai.check", projectId, profileId: model(app, url), tokenBudget: 20000,
    })));
    expect(task.status).toBe("failed");
    expect(task.error).toContain("不能将无效检查视为通过");
  });
  it("keeps previous batch facts in a length revision request", async () => {
    const { app, projectId } = setup();
    const chapterIds = chapters(app, projectId, 3);
    const prompts: string[] = [];
    let generation = 0;
    const url = await fixture((res, body) => {
      const system = body.messages[0].content;
      if (system.includes("issues")) return reply(res, JSON.stringify({ issues: [], majorChange: false }));
      if (system.includes("只修订本章正文长度")) {
        prompts.push(body.messages[1].content);
        return reply(res, "乙".repeat(100));
      }
      generation++;
      reply(res, generation === 1 ? "钥匙已被烧毁。" + "甲".repeat(90) : "乙".repeat(generation === 2 ? 200 : 100));
    });
    const task = await finish(app, ok(await app.dispatch({
      type: "ai.chapter", projectId, profileId: model(app, url), chapterIds,
      authorizeBatch: true, chapterWords: 100, tokenBudget: 100000,
    })));
    expect(task.status).toBe("awaiting-author");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("钥匙已被烧毁。");
    expect((task.result as any).candidates.every((c: any) => c.checked)).toBe(true);
  });
  it("reserves a bounded reasoning allowance for official Pro checks", async () => {
    const bodies: any[] = [];
    const local = await fixture((res, body) => {
      bodies.push(body);
      reply(res, JSON.stringify({ issues: [], majorChange: false }));
    });
    const { app, projectId } = setup({
      fetch: (_url: string, init: RequestInit) =>
        fetch(local + "/chat/completions", init),
    });
    const profileId = model(app, "https://api.deepseek.com", "checking");
    const p = app.snapshot().profiles[0];
    ok(
      app.domain.execute({
        type: "profile.save",
        id: profileId,
        revision: p.revision,
        name: p.name,
        baseUrl: p.baseUrl,
        model: "deepseek-v4-pro",
        purpose: "checking",
      }),
    );
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId,
          tokenBudget: 20000,
        }),
      ),
    );
    expect(task.status).toBe("completed");
    expect(bodies).toHaveLength(2);
    expect(
      bodies.every(
        (b) =>
          b.max_tokens === 8000 &&
          b.thinking.type === "enabled" &&
          b.response_format.type === "json_object",
      ),
    ).toBe(true);
  });
  it("independently reviews an empty initial check and catches a missed factual conflict", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "林舟27岁。同一天，他刚过18岁生日。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(
        res,
        JSON.stringify({
          issues:
            calls === 1
              ? []
              : [
                  {
                    type: "character",
                    reason: "同日年龄互斥",
                    evidence: ["林舟27岁。", "同一天，他刚过18岁生日。"].map(
                      (quote) => ({
                        quote,
                        source: { kind: "chapter", id, revision: 3 },
                      }),
                    ),
                  },
                ],
          majorChange: false,
        }),
      );
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 10000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(app.snapshot().issues).toHaveLength(1);
    expect(task.calls).toBe(2);
  });
  it("repairs an altered quote once and still verifies the actual contradiction", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "纸放回信封。桌上的同一张纸被风吹翻。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(
        res,
        JSON.stringify({
          issues: [
            {
              type: "world",
              reason: "同一张纸同时在信封内和桌面上",
              evidence: (calls === 1
                ? ["纸已经放进信封。", "桌上的同一张纸被风吹翻。"]
                : ["纸放回信封。", "桌上的同一张纸被风吹翻。"]
              ).map((quote) => ({
                quote,
                source: { kind: "chapter", id, revision: 3 },
              })),
            },
          ],
          majorChange: false,
        }),
      );
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 20000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(task.calls).toBe(3);
    expect(app.snapshot().issues[0].evidence.map((e) => e.quote)).toEqual([
      "纸放回信封。",
      "桌上的同一张纸被风吹翻。",
    ]);
    expect(JSON.stringify(task.result)).toContain("格式修正");
  });
  it("corrects an oversized candidate once, preserving the original version and author draft", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    const responses = [
      "甲".repeat(240),
      "乙".repeat(100),
      JSON.stringify({ issues: [], majorChange: false }),
      JSON.stringify({ issues: [], majorChange: false }),
    ];
    const url = await fixture((res) => reply(res, responses.shift()!));
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId: model(app, url),
          chapterIds: [id],
          chapterWords: 100,
          tokenBudget: 20000,
        } as Command),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect((task.result as any).candidates[0]).toMatchObject({
      text: "乙".repeat(100),
      lengthAttempts: 1,
      checked: true,
    });
    expect(
      app
        .snapshot()
        .versions.filter((v) => v.reason === "ai-candidate")
        .map((v) => v.content),
    ).toEqual(["甲".repeat(240), "乙".repeat(100)]);
    expect(app.snapshot().chapters[0].content).toBe("");
    expect(task.calls).toBe(4);
  });
  it("pauses a still oversized revision without an unbounded rewrite loop", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(res, "甲".repeat(240));
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId: model(app, url),
          chapterIds: [id],
          chapterWords: 100,
          tokenBudget: 20000,
        } as Command),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect((task.result as any).pauseReason).toContain("字数");
    expect((task.result as any).candidates[0].needsReview).toBe(true);
    expect(calls).toBe(3);
  });
  it("makes a second bounded correction when the first narrowly misses the word range", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    const outputs = ["甲".repeat(350), "乙".repeat(198), "丙".repeat(250)];
    const url = await fixture((res, body) =>
      reply(
        res,
        body.messages[0].content.includes("issues")
          ? JSON.stringify({ issues: [], majorChange: false })
          : outputs.shift()!,
      ),
    );
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId: model(app, url),
          chapterIds: [id],
          chapterWords: 250,
          tokenBudget: 20000,
        }),
      ),
    );
    expect((task.result as any).candidates[0]).toMatchObject({
      text: "丙".repeat(250),
      lengthAttempts: 2,
      checked: true,
    });
    expect(
      app.snapshot().versions.filter((v) => v.reason === "ai-candidate"),
    ).toHaveLength(3);
    expect(task.calls).toBe(5);
  });
  it("restores original quote whitespace without accepting rewritten facts", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "信纸放回信封。\n\n同一张信纸仍在桌上。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    const url = await fixture((res) =>
      reply(
        res,
        JSON.stringify({
          issues: [
            {
              type: "location",
              reason: "同纸两个位置",
              evidence: [
                {
                  quote: "信纸放回信封。\n同一张信纸仍在桌上。",
                  source: { kind: "chapter", id, revision: 3 },
                },
              ],
            },
          ],
          majorChange: false,
        }),
      ),
    );
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 10000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(app.snapshot().issues[0].evidence[0].quote).toBe(
      "信纸放回信封。\n\n同一张信纸仍在桌上。",
    );
    expect(task.calls).toBe(2);
  });
  it("refuses an ambiguous whitespace-normalized quote", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "纸在\n柜台。纸在  柜台。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    const url = await fixture((res) =>
      reply(
        res,
        JSON.stringify({
          issues: [
            {
              type: "location",
              reason: "无法确定引文位置",
              evidence: [
                {
                  quote: "纸在\t柜台。",
                  source: { kind: "chapter", id, revision: 3 },
                },
              ],
            },
          ],
          majorChange: false,
        }),
      ),
    );
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 10000,
        }),
      ),
    );
    expect(task.status).toBe("failed");
    expect(app.snapshot().issues).toHaveLength(0);
  });
  it("preserves the first candidate when the budget cannot pay for a length correction", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(res, "甲".repeat(240), 9900);
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId: model(app, url),
          chapterIds: [id],
          chapterWords: 100,
          tokenBudget: 10000,
        } as Command),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(task.error).toContain("预算");
    expect((task.result as any).candidates[0].text).toBe("甲".repeat(240));
    expect(
      app.snapshot().versions.filter((v) => v.reason === "ai-candidate"),
    ).toHaveLength(1);
    expect(calls).toBe(1);
  });
  it("resumes a cancelled length correction after restart without discarding its original candidate", async () => {
    const { app, projectId, dir } = setup();
    const [id] = chapters(app, projectId, 1);
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      if (calls === 1) reply(res, "甲".repeat(240));
      else if (calls === 2) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "乙".repeat(30) } }] })}\n\n`,
        );
      } else if (calls === 3) reply(res, "丙".repeat(70));
      else reply(res, JSON.stringify({ issues: [], majorChange: false }));
    });
    const taskId = ok(
      await app.dispatch({
        type: "ai.chapter",
        projectId,
        profileId: model(app, url),
        chapterIds: [id],
        chapterWords: 100,
        tokenBudget: 20000,
      } as Command),
    );
    for (let i = 0; i < 100; i++) {
      if (
        app.snapshot().tasks.find((t) => t.id === taskId)?.partial ===
        "乙".repeat(30)
      )
        break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(app.snapshot().tasks.find((t) => t.id === taskId)?.partial).toBe(
      "乙".repeat(30),
    );
    ok(await app.dispatch({ type: "task.cancel", id: taskId }));
    await finish(app, taskId);
    await app.dispose();
    apps.splice(apps.indexOf(app), 1);
    const next = new AppServices({
      dataDir: dir,
      credentials: {
        encrypt: (s) => Buffer.from("protected-" + s),
        decrypt: (b) => Buffer.from(b).toString().slice(10),
      },
      dialogs: { open: async () => null, save: async () => null },
    });
    apps.push(next);
    ok(
      await next.dispatch({
        type: "task.resume",
        id: taskId,
        mode: "continue",
      }),
    );
    const done = await finish(next, taskId);
    expect((done.result as any).candidates[0]).toMatchObject({
      text: "乙".repeat(30) + "丙".repeat(70),
      lengthAttempts: 1,
      checked: true,
    });
    expect(
      next.snapshot().versions.filter((v) => v.reason === "ai-candidate"),
    ).toHaveLength(2);
    expect(calls).toBe(5);
  });
  it("reviews a clean assessment without turning passed checks into stored conflicts", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "周五打扫书店，周六举行读书会。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(
        res,
        JSON.stringify({
          issues:
            calls === 1
              ? [
                  {
                    type: "timeline",
                    reason: "时间推进一致，暂无不一致",
                    evidence: [
                      {
                        quote: "周五打扫书店，周六举行读书会。",
                        source: { kind: "chapter", id, revision: 3 },
                      },
                    ],
                  },
                ]
              : [],
          majorChange: false,
        }),
      );
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 10000,
        }),
      ),
    );
    expect(task.status).toBe("completed");
    expect(app.snapshot().issues).toHaveLength(0);
    expect(task.calls).toBe(2);
    expect(JSON.stringify(task.result)).toContain("复核");
    expect(JSON.stringify(task.result)).toContain("暂无不一致");
  });
  it("keeps a verified conflict but removes its unrelated quote", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "他拆开。林舟今年27岁。林舟同一天说自己18岁。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      const quotes =
        calls === 1
          ? ["他拆开。", "林舟今年27岁。", "林舟同一天说自己18岁。"]
          : ["林舟今年27岁。", "林舟同一天说自己18岁。"];
      reply(
        res,
        JSON.stringify({
          issues: [
            {
              type: "character",
              reason: "同一人物同一天有两个互斥年龄",
              evidence: quotes.map((quote) => ({
                quote,
                source: { kind: "chapter", id, revision: 3 },
              })),
            },
          ],
          majorChange: false,
        }),
      );
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 10000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(app.snapshot().issues[0].evidence.map((e) => e.quote)).toEqual([
      "林舟今年27岁。",
      "林舟同一天说自己18岁。",
    ]);
    expect(task.calls).toBe(2);
  });
  it("rejects invented evidence from the review rather than marking a check passed", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "纸放回信封。桌上的同一张纸被风吹翻。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(
        res,
        JSON.stringify({
          issues: [
            {
              type: "world",
              reason: "物体状态矛盾",
              evidence: [
                {
                  quote: calls === 1 ? "纸放回信封。" : "作者从未写过的证据",
                  source: { kind: "chapter", id, revision: 3 },
                },
              ],
            },
          ],
          majorChange: false,
        }),
      );
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 10000,
        }),
      ),
    );
    expect(task.status).toBe("failed");
    expect(app.snapshot().issues).toHaveLength(0);
  });
  it("does not call a review beyond the remaining task budget", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "同一人物27岁又18岁。",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(
        res,
        JSON.stringify({
          issues: [
            {
              type: "character",
              reason: "年龄矛盾",
              evidence: [
                {
                  quote: "同一人物27岁又18岁。",
                  source: { kind: "chapter", id, revision: 3 },
                },
              ],
            },
          ],
          majorChange: false,
        }),
        4900,
      );
    });
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId: model(app, url),
          tokenBudget: 5000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(task.error).toContain("预算");
    expect(app.snapshot().issues).toHaveLength(0);
    expect(calls).toBe(1);
  });
  it("isolates unrelated unconfirmed drafts and saves planning only for author acceptance", async () => {
    let prompt = "";
    const url = await fixture((res, b) => {
      prompt = JSON.stringify(b.messages);
      reply(res, "人物建议");
    });
    const { app, projectId } = setup();
    const ids = chapters(app, projectId, 2);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id: ids[0],
        revision: 1,
        content: "未确认私有草稿",
      }),
    );
    const profileId = model(app, url, "planning");
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.plan",
          projectId,
          profileId,
          step: "character",
          tokenBudget: 5000,
          instruction: "补充人物",
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(prompt).not.toContain("未确认私有草稿");
    expect(JSON.stringify(task.result)).toContain("人物建议");
    expect(app.snapshot().notes).toHaveLength(0);
  });
  it("uses a separate planning output limit with a two-million-token total budget", async () => {
    let request: any;
    const url = await fixture((res, body) => { request = body; reply(res, "完整规划"); });
    const { app, projectId } = setup();
    const profileId = model(app, url, "planning");
    const task = await finish(app, ok(await app.dispatch({ type: "ai.plan", projectId, profileId, step: "outline", tokenBudget: 2000000 })));
    expect(task.status).toBe("awaiting-author");
    expect(request.max_tokens).toBe(8000);
    expect(request.messages[1].content).toContain('"targetWords":100000');
  });
  it("retains and resumes limited planning without confusing its word ceiling with chapter length", async () => {
    const requests: any[] = [];
    const url = await fixture((res, body) => {
      requests.push(body);
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: requests.length === 1 ? "人物规划。" : "关系补充。" }, finish_reason: requests.length === 1 ? "length" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } })}\n\ndata: [DONE]\n\n`);
    });
    const { app, projectId } = setup();
    const profileId = model(app, url, "planning");
    const id = ok(await app.dispatch({ type: "ai.plan", projectId, profileId, step: "character", tokenBudget: 2000000, planningMaxWords: 300000, maxOutputTokens: 16000 } as any));
    const limited = await finish(app, id);
    expect(limited.status).toBe("interrupted");
    expect(limited.partial).toBe("人物规划。");
    expect(limited.usage).toMatchObject({ totalTokens: 300, estimated: false });
    expect(limited.error).toContain("单次输出上限");
    expect(requests[0].max_tokens).toBe(16000);
    expect(requests[0].messages[0].content).toContain("300000");
    ok(await app.dispatch({ type: "task.resume", id, mode: "continue" }));
    const complete = await finish(app, id);
    expect((complete.result as any).suggestion).toBe("人物规划。关系补充。");
    expect(complete.usage).toMatchObject({ totalTokens: 600, estimated: false });
    expect(requests[1].messages[1].content).toContain("人物规划。");
    expect(app.snapshot().projects[0].chapterWords).toBe(100);
  });
  it("stops planning at the author's word ceiling even if the model exceeds it", async () => {
    const url = await fixture((res) => reply(res, "一二三四五六七八九十"));
    const { app, projectId } = setup();
    const profileId = model(app, url, "planning");
    const task = await finish(app, ok(await app.dispatch({ type: "ai.plan", projectId, profileId, step: "outline", tokenBudget: 2000000, planningMaxWords: 5 } as any)));
    expect((task.result as any).suggestion).toBe("一二三四五");
    expect((task.result as any).pauseReason).toContain("字数上限");
    expect(task.calls).toBe(1);
  });
  it("applies the planning word ceiling cumulatively across continuations", async () => {
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: calls === 1 ? "一二三" : "四五六七" }, finish_reason: calls === 1 ? "length" : "stop" }] }));
    });
    const { app, projectId } = setup();
    const profileId = model(app, url, "planning");
    const id = ok(await app.dispatch({ type: "ai.plan", projectId, profileId, step: "outline", tokenBudget: 20000, planningMaxWords: 5 }));
    expect((await finish(app, id)).status).toBe("interrupted");
    ok(await app.dispatch({ type: "task.resume", id, mode: "continue" }));
    expect(((await finish(app, id)).result as any).suggestion).toBe("一二三四五");
    expect((await app.dispatch({ type: "task.resume", id, mode: "continue" })).ok).toBe(false);
    expect(calls).toBe(2);
  });
  it("continues legacy planning beyond 10000 words without imposing a new smaller ceiling", async () => {
    let calls = 0;
    const prefix = "旧".repeat(11000);
    const url = await fixture((res) => {
      calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: calls === 1 ? prefix : "新增规划" }, finish_reason: calls === 1 ? "length" : "stop" }] }));
    });
    const { app, projectId } = setup();
    const profileId = model(app, url, "planning");
    const id = ok(await app.dispatch({ type: "ai.plan", projectId, profileId, step: "outline", tokenBudget: 100000 }));
    expect((await finish(app, id)).status).toBe("interrupted");
    ok(await app.dispatch({ type: "task.resume", id, mode: "continue" }));
    expect(((await finish(app, id)).result as any).suggestion).toBe(prefix + "新增规划");
  });
  it("cannot continue a truncated plan beyond the remaining task budget", async () => {
    let calls = 0;
    const url = await fixture((res, body) => {
      calls++;
      expect(body.max_tokens).toBeLessThan(1000);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "保留规划片段" }, finish_reason: "length" }], usage: { prompt_tokens: 300, completion_tokens: 600, total_tokens: 900 } }));
    });
    const { app, projectId } = setup();
    const profileId = model(app, url, "planning");
    const id = ok(await app.dispatch({ type: "ai.plan", projectId, profileId, step: "outline", tokenBudget: 1000 }));
    expect((await finish(app, id)).status).toBe("interrupted");
    ok(await app.dispatch({ type: "task.resume", id, mode: "continue" }));
    const paused = await finish(app, id);
    expect(paused.error).toContain("预算");
    expect(paused.partial).toBe("保留规划片段");
    expect(calls).toBe(1);
  });
  it.each([{ planningMaxWords: 300001 }, { planningMaxWords: 0 }, { maxOutputTokens: 32001 }, { maxOutputTokens: 1.5 }])("rejects invalid planning limits before a model call: %j", async (limits) => {
    let calls = 0;
    const url = await fixture((res) => { calls++; reply(res, "规划"); });
    const { app, projectId } = setup();
    const profileId = model(app, url, "planning");
    expect((await app.dispatch({ type: "ai.plan", projectId, profileId, step: "outline", tokenBudget: 2000000, ...limits })).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("authorizes draft context explicitly and discloses truncation of oversized setting", async () => {
    let prompt = "";
    const url = await fixture((res, b) => {
      prompt = JSON.stringify(b.messages);
      reply(res, "建议");
    });
    const { app, projectId } = setup({ maxContextChars: 2000 });
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "明确授权草稿",
      }),
    );
    ok(
      app.domain.execute({
        type: "note.save",
        projectId,
        noteType: "world",
        title: "长设定",
        body: "世界".repeat(5000),
        sources: [],
      }),
    );
    const profileId = model(app, url, "planning");
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.plan",
          projectId,
          profileId,
          step: "outline",
          tokenBudget: 5000,
          includeDraftIds: [id],
        }),
      ),
    );
    expect(prompt).toContain("明确授权草稿");
    expect(prompt.length).toBeLessThan(4000);
    expect(JSON.stringify(task.result)).toContain("截断");
  });
  it("keeps author edits and retains stale candidate text as awaiting author", async () => {
    let output: ServerResponse | undefined;
    const url = await fixture((res) => {
      output = res;
    });
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    const profileId = model(app, url);
    const tid = ok(
      await app.dispatch({
        type: "ai.chapter",
        projectId,
        profileId,
        chapterIds: [id],
        tokenBudget: 5000,
      }),
    );
    while (!output) await new Promise((r) => setTimeout(r, 2));
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "作者正在编辑",
      }),
    );
    reply(output, "候选全文");
    const task = await finish(app, tid);
    expect(task.status).toBe("awaiting-author");
    expect(JSON.stringify(task.result)).toContain("候选全文");
    expect(app.snapshot().chapters[0].content).toBe("作者正在编辑");
    expect(
      app.snapshot().versions.filter((v) => v.reason === "ai-candidate"),
    ).toHaveLength(0);
  });
  it("uses same-batch candidates without changing current chapters and pauses on major check conflict", async () => {
    const prompts: string[] = [];
    let calls = 0;
    let writes = 0;
    const url = await fixture((res, b) => {
      calls++;
      prompts.push(JSON.stringify(b.messages));
      if (!b.messages[0].content.includes("issues"))
        reply(res, ++writes === 1 ? "第一章候选" : "第二章候选");
      else if (writes === 1)
        reply(res, JSON.stringify({ issues: [], majorChange: false }));
      else
        reply(
          res,
          JSON.stringify({
            issues: [],
            majorChange: true,
            reason: "重大剧情变化",
          }),
        );
    });
    const { app, projectId } = setup();
    const ids = chapters(app, projectId, 3),
      profileId = model(app, url);
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId,
          chapterIds: ids,
          authorizeBatch: true,
          tokenBudget: 20000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(calls).toBe(6);
    expect(prompts[3]).toContain("第一章候选");
    expect(
      app.snapshot().versions.filter((v) => v.reason === "ai-candidate"),
    ).toHaveLength(2);
    expect(
      app
        .snapshot()
        .chapters.every((c) => c.content === "" && c.status === "draft"),
    ).toBe(true);
  });
  it("rejects two chapter batches or unauthorized 3 chapter runs before any request", async () => {
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(res, "不能调用");
    });
    const { app, projectId } = setup();
    const ids = chapters(app, projectId, 3),
      profileId = model(app, url);
    for (const chapterIds of [ids.slice(0, 2), ids])
      expect(
        (
          await app.dispatch({
            type: "ai.chapter",
            projectId,
            profileId,
            chapterIds,
            tokenBudget: 5000,
          })
        ).ok,
      ).toBe(false);
    expect(calls).toBe(0);
  });
  it("cancels output retaining fragment and resumes without duplicate saved candidates", async () => {
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      if (calls === 1) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"content":"开头片段"}}]}\n\n');
      } else if (calls === 2) reply(res, "继续正文");
      else reply(res, JSON.stringify({ issues: [], majorChange: false }));
    });
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1),
      profileId = model(app, url);
    const tid = ok(
      await app.dispatch({
        type: "ai.chapter",
        projectId,
        profileId,
        chapterIds: [id],
        tokenBudget: 5000,
      }),
    );
    while (!app.snapshot().tasks.find((t) => t.id === tid)?.partial)
      await new Promise((r) => setTimeout(r, 2));
    ok(await app.dispatch({ type: "task.cancel", id: tid }));
    expect((await finish(app, tid)).partial).toBe("开头片段");
    ok(await app.dispatch({ type: "task.resume", id: tid, mode: "continue" }));
    const task = await finish(app, tid);
    expect(task.status).toBe("awaiting-author");
    expect(
      app.snapshot().versions.filter((v) => v.reason === "ai-candidate"),
    ).toHaveLength(1);
    expect(
      app.snapshot().versions.find((v) => v.reason === "ai-candidate")?.content,
    ).toBe("开头片段继续正文");
  });
  it("rejects invented check evidence and malformed JSON rather than silently passing", async () => {
    let text = "not json";
    const url = await fixture((res) => reply(res, text));
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "人物在北京",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    const profileId = model(app, url, "checking");
    let t = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId,
          chapterIds: [id],
          tokenBudget: 5000,
        }),
      ),
    );
    expect(t.status).toBe("failed");
    text = JSON.stringify({
      issues: [
        {
          type: "location",
          reason: "矛盾",
          evidence: [
            {
              quote: "根本不存在",
              source: { kind: "chapter", id, revision: 3 },
            },
          ],
        },
      ],
    });
    t = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId,
          chapterIds: [id],
          tokenBudget: 5000,
        }),
      ),
    );
    expect(t.status).toBe("failed");
    expect(app.snapshot().issues).toHaveLength(0);
  });
  it("saves real quoted consistency evidence and requires author resolution", async () => {
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "前文在北京，后文在上海",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    const url = await fixture((res) =>
      reply(
        res,
        JSON.stringify({
          issues: [
            {
              type: "location",
              reason: "没有交代移动",
              evidence: [
                {
                  quote: "前文在北京",
                  source: { kind: "chapter", id, revision: 3 },
                },
                {
                  quote: "后文在上海",
                  source: { kind: "chapter", id, revision: 3 },
                },
              ],
            },
          ],
        }),
      ),
    );
    const profileId = model(app, url, "checking");
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.check",
          projectId,
          profileId,
          chapterIds: [id],
          tokenBudget: 5000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(app.snapshot().issues[0].evidence).toHaveLength(2);
    expect(app.snapshot().issues[0].status).toBe("open");
  });
  it("stops before exhausting remaining budget and keeps unknown usage estimated", async () => {
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "正文" } }] }));
    });
    const { app, projectId } = setup();
    const ids = chapters(app, projectId, 3),
      profileId = model(app, url);
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId,
          chapterIds: ids,
          authorizeBatch: true,
          tokenBudget: 600,
        }),
      ),
    );
    expect(calls).toBeLessThan(6);
    expect(task.usage?.estimated).toBe(true);
    expect(task.usage?.totalTokens).toBeGreaterThan(0);
    expect(task.status).toBe("awaiting-author");
  });
  it("extracts reviewable material with source attribution without auto-approval", async () => {
    const url = await fixture((res) =>
      reply(
        res,
        JSON.stringify({
          materials: [
            {
              type: "expression",
              title: "候选表达",
              content: "笑不活了",
              explanation: "仅现代语境",
            },
          ],
        }),
      ),
    );
    const { app, projectId } = setup(),
      profileId = model(app, url, "planning");
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.extract",
          projectId,
          profileId,
          sourceText: "笑不活了，这是一个表达",
          source: "作者粘贴",
          tokenBudget: 5000,
        }),
      ),
    );
    expect(task.status).toBe("awaiting-author");
    expect(JSON.stringify(task.result)).toContain("作者粘贴");
    expect(app.snapshot().materials).toHaveLength(0);
  });
  it("masks fragmented echoed credentials from tasks and creates coherent key-free recovery snapshots", async () => {
    const url = await fixture((res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"DO-NOT-"}}]}\n\n');
      setTimeout(
        () =>
          res.end(
            'data: {"choices":[{"delta":{"content":"LEAK 正文"}}]}\n\ndata: [DONE]\n\n',
          ),
        5,
      );
    });
    const { app, projectId, dir } = setup({ recoveryIntervalMs: 10 }),
      profileId = model(app, url, "planning");
    await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.plan",
          projectId,
          profileId,
          step: "idea",
          tokenBudget: 5000,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    const publicState = JSON.stringify(app.snapshot());
    expect(publicState).not.toContain("DO-NOT-");
    const backups = readdirSync(join(dir, "recovery"));
    expect(backups.length).toBeGreaterThan(0);
    expect(backups.length).toBeLessThanOrEqual(20);
    for (const p of backups) {
      const raw = readFileSync(join(dir, "recovery", p), "utf8");
      expect(raw).not.toMatch(/DO-NOT-|protected-|ciphertext|credentials/i);
      expect(JSON.parse(raw).sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("marks persisted running tasks interrupted at restart and closes cancelled tasks safely", async () => {
    const url = await fixture((res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"片段"}}]}\n\n');
    });
    const { app, projectId, dir } = setup(),
      profileId = model(app, url);
    const tid = ok(
      await app.dispatch({
        type: "ai.plan",
        projectId,
        profileId,
        step: "idea",
        tokenBudget: 5000,
      }),
    );
    while (!app.snapshot().tasks.find((t) => t.id === tid)?.partial)
      await new Promise((r) => setTimeout(r, 2));
    await app.dispose();
    apps.splice(apps.indexOf(app), 1);
    const next = new AppServices({
      dataDir: dir,
      dialogs: { open: async () => null, save: async () => null },
    });
    apps.push(next);
    expect(next.snapshot().tasks.find((t) => t.id === tid)?.status).toBe(
      "interrupted",
    );
    expect(next.snapshot().tasks.find((t) => t.id === tid)?.partial).toBe(
      "片段",
    );
  });
  it("returns Chinese validation errors for forged async fields and never exposes dialog paths", async () => {
    const { app } = setup();
    expect(
      (
        await app.dispatch({
          type: "file.importBackup",
          path: "/etc/passwd",
        } as unknown as Command)
      ).ok,
    ).toBe(false);
    expect((await app.dispatch({ type: "file.importBackup" })).ok).toBe(false);
  });
  it("bounds later batch prompts and validates prior candidate evidence with its version", async () => {
    const { app, projectId } = setup({ maxContextChars: 2000 });
    const ids = chapters(app, projectId, 3);
    let calls = 0;
    let maxLength = 0;
    let writes = 0;
    const url = await fixture((res, b) => {
      calls++;
      maxLength = Math.max(maxLength, JSON.stringify(b.messages).length);
      if (!b.messages[0].content.includes("issues")) {
        writes++;
        reply(res, `批次候选${writes} ` + "正文".repeat(2500));
      } else if (writes === 2 && b.messages[1].content.includes("批次候选1")) {
        const version = app
          .snapshot()
          .versions.find((v) => v.reason === "ai-candidate")!;
        reply(
          res,
          JSON.stringify({
            issues: [
              {
                type: "character",
                reason: "待核对",
                evidence: [
                  {
                    quote: "批次候选1",
                    source: { kind: "chapter", id: ids[0], revision: 1 },
                  },
                ],
              },
            ],
            majorChange: false,
          }),
        );
      } else reply(res, JSON.stringify({ issues: [], majorChange: false }));
    });
    const profileId = model(app, url);
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId,
          chapterIds: ids,
          authorizeBatch: true,
          tokenBudget: 100000,
        }),
      ),
    );
    expect(maxLength).toBeLessThan(4000);
    expect(task.status, task.error).toBe("awaiting-author");
    const candidates = (task.result as any).candidates;
    expect(candidates[1].check.issues[0].evidence[0].candidateVersionId).toBe(
      candidates[0].versionId,
    );
    expect(JSON.stringify(task.result)).toContain("截断");
  });
  it("retains raw malformed extraction output and accounts for failed retry reservations", async () => {
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      if (calls < 3) {
        res.writeHead(503);
        res.end("busy");
      } else reply(res, "invalid material JSON");
    });
    const { app, projectId } = setup(),
      profileId = model(app, url, "planning");
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.extract",
          projectId,
          profileId,
          source: "粘贴",
          sourceText: "来源内容",
          tokenBudget: 100000,
        }),
      ),
    );
    expect(task.status).toBe("failed");
    expect(task.partial).toBe("invalid material JSON");
    expect(task.calls).toBe(3);
    expect(task.usage?.estimated).toBe(true);
    expect(task.usage?.totalTokens).toBeGreaterThan(30);
  });
  it("imports periodic recovery as copies including unlinked materials without credentials", async () => {
    let selected: string | null = null;
    const { app, projectId, dir } = setup({
      recoveryIntervalMs: 10,
      dialogs: { open: async () => selected, save: async () => null },
    });
    const second = ok(
      app.domain.execute({ type: "project.create", title: "另一本" }),
    );
    chapters(app, projectId, 1);
    chapters(app, second, 1);
    ok(
      app.domain.execute({
        type: "material.save",
        materialType: "plot",
        title: "未关联素材",
        source: "原始来源",
        content: "桥段",
        explanation: "说明",
        approved: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 35));
    selected = join(
      dir,
      "recovery",
      readdirSync(join(dir, "recovery")).at(-1)!,
    );
    ok(await app.dispatch({ type: "file.importBackup" }));
    expect(app.snapshot().projects).toHaveLength(4);
    expect(
      app.snapshot().materials.filter((m) => m.title === "未关联素材"),
    ).toHaveLength(2);
    expect(app.snapshot().profiles).toHaveLength(0);
  });

  it("refuses resume when a profile snapshot no longer matches credentials configuration", async () => {
    const url = await fixture((res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"保留片段"}}]}\n\n');
    });
    const { app, projectId } = setup();
    const [id] = chapters(app, projectId, 1),
      profileId = model(app, url);
    const taskId = ok(
      await app.dispatch({
        type: "ai.chapter",
        projectId,
        profileId,
        chapterIds: [id],
        tokenBudget: 5000,
      }),
    );
    while (!app.snapshot().tasks.find((t) => t.id === taskId)?.partial)
      await new Promise((r) => setTimeout(r, 2));
    ok(await app.dispatch({ type: "task.cancel", id: taskId }));
    await finish(app, taskId);
    const p = app.snapshot().profiles[0];
    ok(
      app.domain.execute({
        type: "profile.save",
        id: p.id,
        revision: p.revision,
        name: p.name,
        baseUrl: "https://changed.example/v1",
        model: p.model,
        purpose: p.purpose,
      }),
    );
    const resumed = await app.dispatch({
      type: "task.resume",
      id: taskId,
      mode: "continue",
    });
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.error.code).toBe("CONFLICT");
  });
  it("allows cancellation of a paused unfinished batch without deleting candidates", async () => {
    let calls = 0;
    const url = await fixture((res) => {
      calls++;
      reply(
        res,
        calls === 1
          ? "候选正文"
          : JSON.stringify({
              issues: [],
              majorChange: true,
              reason: "剧情变化",
            }),
      );
    });
    const { app, projectId } = setup();
    const ids = chapters(app, projectId, 3),
      profileId = model(app, url);
    const taskId = ok(
      await app.dispatch({
        type: "ai.chapter",
        projectId,
        profileId,
        chapterIds: ids,
        authorizeBatch: true,
        tokenBudget: 5000,
      }),
    );
    await finish(app, taskId);
    ok(await app.dispatch({ type: "task.cancel", id: taskId }));
    expect(app.snapshot().tasks.find((t) => t.id === taskId)?.status).toBe(
      "cancelled",
    );
    expect(
      app.snapshot().versions.filter((v) => v.reason === "ai-candidate"),
    ).toHaveLength(1);
  });

  it("tests a saved model before creating any work and keeps global connection tasks out of works", async () => {
    const url = await fixture((res) => reply(res, "连接成功"));
    const { app, projectId } = setup({ noProject: true });
    const profileId = model(app, url);
    const task = await finish(
      app,
      ok(await app.dispatch({ type: "model.test", profileId })),
    );
    expect(task.status).toBe("completed");
    expect(task.projectId).not.toBe(projectId);
    expect(task.sourceRevisions).toEqual([]);
    expect(app.snapshot().projects).toHaveLength(0);
  });

  it("routes selected TXT import, AI extraction and confirmed export through trusted dialogs", async () => {
    const { app, projectId, dir } = setup({
      dialogs: {
        open: async () => join(dir, "source.txt"),
        save: async (kind: string) => join(dir, "export." + kind),
      },
    });
    writeFileSync(join(dir, "source.txt"), "中文导入材料");
    ok(
      await app.dispatch({
        type: "file.importMaterial",
        source: "手动出处",
        materialType: "expression",
      }),
    );
    expect(app.snapshot().materials[0]).toMatchObject({
      content: "中文导入材料",
      source: "手动出处",
      approved: false,
    });
    const [id] = chapters(app, projectId, 1);
    ok(
      app.domain.execute({
        type: "chapter.save",
        id,
        revision: 1,
        content: "中文已确认",
      }),
    );
    ok(app.domain.execute({ type: "chapter.confirm", id, revision: 2 }));
    ok(await app.dispatch({ type: "file.exportText", projectId }));
    expect(readFileSync(join(dir, "export.txt"), "utf8")).toContain(
      "中文已确认",
    );
    const url = await fixture((res) =>
      reply(
        res,
        JSON.stringify({
          materials: [
            {
              type: "plot",
              title: "关系",
              content: "导入桥段",
              explanation: "适用场景",
            },
          ],
        }),
      ),
    );
    const profileId = model(app, url, "planning");
    const task = await finish(
      app,
      ok(
        await app.dispatch({
          type: "ai.extract",
          projectId,
          profileId,
          source: "选定文件出处",
          tokenBudget: 5000,
        }),
      ),
    );
    expect(JSON.stringify(task.requestSnapshot)).toContain("中文导入材料");
    expect(JSON.stringify(task.result)).toContain("选定文件出处");
    expect(JSON.stringify(task)).not.toContain(dir);
  });
  it("retains only the latest twenty changed coherent recovery snapshots", async () => {
    const { app, projectId, dir } = setup({ recoveryIntervalMs: 2 });
    for (let i = 0; i < 22; i++) {
      const p = app.snapshot().projects.find((p) => p.id === projectId)!;
      ok(
        app.domain.execute({
          type: "project.update",
          id: p.id,
          revision: p.revision,
          patch: { title: "作品-" + i },
        }),
      );
      const previous = app.snapshot().persistence?.lastRecoveryAt;
      for (let n = 0; n < 100; n++) {
        if (app.snapshot().persistence?.lastRecoveryAt !== previous) break;
        await new Promise((r) => setTimeout(r, 2));
      }
    }
    const paths = readdirSync(join(dir, "recovery"))
      .filter((p) => p.endsWith(".novel"))
      .sort();
    expect(paths).toHaveLength(20);
    expect(
      JSON.parse(readFileSync(join(dir, "recovery", paths.at(-1)!), "utf8"))
        .payload.projects[0].title,
    ).toBe("作品-21");
  });
  it("restores work recovery after a global model connection test", async () => {
    let selected: string | null = null;
    const { app, dir } = setup({
      recoveryIntervalMs: 5,
      dialogs: { open: async () => selected, save: async () => null },
    });
    const url = await fixture((res) => reply(res, "连接成功"));
    const profileId = model(app, url);
    await finish(
      app,
      ok(await app.dispatch({ type: "model.test", profileId })),
    );
    await new Promise((r) => setTimeout(r, 20));
    selected = join(
      dir,
      "recovery",
      readdirSync(join(dir, "recovery")).at(-1)!,
    );
    ok(await app.dispatch({ type: "file.importBackup" }));
    expect(app.snapshot().projects).toHaveLength(2);
  });
  it("bounds resumed output context while preserving the complete candidate fragment", async () => {
    const fragment = "片段".repeat(30000);
    let calls = 0,
      maxPrompt = 0;
    const url = await fixture((res, body) => {
      calls++;
      maxPrompt = Math.max(maxPrompt, JSON.stringify(body.messages).length);
      if (calls === 1) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write(
          "data: " +
            JSON.stringify({ choices: [{ delta: { content: fragment } }] }) +
            "\n\n",
        );
      } else if (calls === 2) reply(res, "末尾");
      else reply(res, JSON.stringify({ issues: [], majorChange: false }));
    });
    const { app, projectId } = setup({ maxContextChars: 2000 });
    const [chapterId] = chapters(app, projectId, 1),
      profileId = model(app, url);
    const taskId = ok(
      await app.dispatch({
        type: "ai.chapter",
        projectId,
        profileId,
        chapterIds: [chapterId],
        tokenBudget: 100000,
      }),
    );
    while (!app.snapshot().tasks.find((t) => t.id === taskId)?.partial)
      await new Promise((r) => setTimeout(r, 2));
    ok(await app.dispatch({ type: "task.cancel", id: taskId }));
    await finish(app, taskId);
    ok(
      await app.dispatch({ type: "task.resume", id: taskId, mode: "continue" }),
    );
    await finish(app, taskId);
    expect(maxPrompt).toBeLessThan(16000);
    expect(
      app.snapshot().versions.find((v) => v.reason === "ai-candidate")?.content,
    ).toBe(fragment + "末尾");
  });
  it.each(["ai.check", "ai.plan", "ai.extract"] as const)(
    "preserves prose and regenerates source headers when resuming imported %s",
    async (type) => {
      let selected: string | null = null;
      let importedChapterId = "";
      let resumedPrompt = "";
      let originalChapterId = "";
      const url = await fixture((res, body) => {
        if (!importedChapterId) {
          if (type === "ai.plan") {
            res.writeHead(401);
            res.end("unauthorized");
          } else reply(res, "invalid structured output");
          return;
        }
        resumedPrompt = body.messages.find(
          (m: any) => m.role === "user",
        ).content;
        if (type === "ai.check") {
          const sourceId = /\[chapter:([^@]+)@3\]/.exec(resumedPrompt)![1];
          reply(
            res,
            JSON.stringify({
              issues: [
                {
                  type: "location",
                  reason: "移动未交代",
                  evidence: [
                    {
                      quote: "人物在北京",
                      source: { kind: "chapter", id: sourceId, revision: 3 },
                    },
                  ],
                },
              ],
              majorChange: false,
            }),
          );
        } else if (type === "ai.plan") reply(res, "以所列来源为依据的人物建议");
        else
          reply(
            res,
            JSON.stringify({
              materials: [
                {
                  type: "plot",
                  title: "原文编号",
                  content: `作者原文引用旧编号 ${originalChapterId}`,
                  explanation: "作者文本保持原样",
                },
              ],
            }),
          );
      });
      const { app, projectId, dir } = setup({
        dialogs: {
          open: async () => selected,
          save: async () => join(dir, "roundtrip.novel"),
        },
      });
      [originalChapterId] = chapters(app, projectId, 1);
      const authorProse = `作者原文引用旧编号 ${originalChapterId}。人物在北京，后文在上海。`;
      ok(
        app.domain.execute({
          type: "chapter.save",
          id: originalChapterId,
          revision: 1,
          content: authorProse,
        }),
      );
      ok(
        app.domain.execute({
          type: "chapter.confirm",
          id: originalChapterId,
          revision: 2,
        }),
      );
      const profileId = model(
        app,
        url,
        type === "ai.check" ? "checking" : "planning",
      );
      const base = { projectId, profileId, tokenBudget: 20000 };
      const command: Command =
        type === "ai.check"
          ? { type, ...base, chapterIds: [originalChapterId] }
          : type === "ai.plan"
            ? { type, ...base, step: "character" }
            : { type, ...base, source: "作者原文", sourceText: authorProse };
      const taskId = ok(await app.dispatch(command));
      expect((await finish(app, taskId)).status).toBe("failed");
      ok(await app.dispatch({ type: "file.backup", projectId }));
      selected = join(dir, "roundtrip.novel");
      const importedProjectId = ok(
        await app.dispatch({ type: "file.importBackup" }),
      );
      importedChapterId = app
        .snapshot()
        .chapters.find((c) => c.projectId === importedProjectId)!.id;
      expect(importedChapterId).not.toBe(originalChapterId);
      expect(
        app.snapshot().chapters.find((c) => c.id === importedChapterId)!
          .content,
      ).toBe(authorProse);
      const importedTask = app
        .snapshot()
        .tasks.find((t) => t.projectId === importedProjectId)!;
      ok(
        await app.dispatch({
          type: "task.resume",
          id: importedTask.id,
          mode: "rewrite",
        }),
      );
      const result = await finish(app, importedTask.id);
      expect(result.status).toBe("awaiting-author");
      expect(resumedPrompt).toContain(
        `作者原文引用旧编号 ${originalChapterId}`,
      );
      if (type !== "ai.extract") {
        expect(resumedPrompt).toContain(`[chapter:${importedChapterId}@3]`);
        expect(resumedPrompt).not.toContain(`[chapter:${originalChapterId}@3]`);
      }
      if (type === "ai.check") {
        const issue = app
          .snapshot()
          .issues.find((i) => i.projectId === importedProjectId)!;
        expect(issue.evidence[0].source.id).toBe(importedChapterId);
        expect(issue.evidence[0].quote).toBe("人物在北京");
      }
    },
  );
  it.each(["failed", "cancelled"] as const)(
    "retains every planning fragment across two %s continuations",
    async (interruption) => {
      let calls = 0;
      const prompts: string[] = [];
      const url = await fixture((res, body) => {
        calls++;
        prompts.push(body.messages[1].content);
        if (calls < 3) {
          res.setHeader("Content-Type", "text/event-stream");
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: calls === 1 ? "FIRST" : "SECOND" } }] })}\n\n`,
          );
          if (interruption === "failed") res.end();
        } else reply(res, "THIRD");
      });
      const { app, projectId } = setup();
      const profileId = ok(
        app.domain.execute({
          type: "profile.save",
          name: "无密钥本地规划",
          baseUrl: url,
          model: "fixture",
          purpose: "planning",
        }),
      );
      const id = ok(
        await app.dispatch({
          type: "ai.plan",
          projectId,
          profileId,
          step: "outline",
          tokenBudget: 30000,
        }),
      );
      for (let index = 0; index < 2; index++) {
        if (interruption === "cancelled") {
          while (
            !app
              .snapshot()
              .tasks.find((t) => t.id === id)
              ?.partial.endsWith(index ? "SECOND" : "FIRST")
          )
            await new Promise((r) => setTimeout(r, 2));
          ok(await app.dispatch({ type: "task.cancel", id }));
        }
        const task = await finish(app, id);
        expect(task.status).toBe(interruption);
        expect(task.partial).toBe(index ? "FIRSTSECOND" : "FIRST");
        ok(await app.dispatch({ type: "task.resume", id, mode: "continue" }));
      }
      const completed = await finish(app, id);
      expect(completed.status).toBe("awaiting-author");
      expect((completed.result as any).suggestion).toBe("FIRSTSECONDTHIRD");
      expect(prompts[2]).toContain("FIRSTSECOND");
      expect(completed.calls).toBe(3);
    },
  );
  it.each([
    "null request",
    "wrong command kind",
    "bad context documents",
    "bad context source",
    "bad context materials",
    "nonarray candidates",
    "bad candidate text",
    "bad candidate check",
    "nonarray materials",
    "wrong result discriminant",
    "foreign candidate",
    "foreign version",
    "foreign command owner",
    "length phase without target",
    "length phase without pending candidate",
  ])(
    "atomically rejects a valid-checksum producer package with %s",
    async (malformation) => {
      let selected: string | null = null;
      const { app, projectId, dir } = setup({
        dialogs: {
          open: async () => selected,
          save: async () => join(dir, "producer.novel"),
        },
      });
      const [chapterId] = chapters(app, projectId, 1);
      const url = await fixture((res) => {
        res.writeHead(401);
        res.end("bad key");
      });
      const profileId = model(app, url);
      const taskId = ok(
        await app.dispatch({
          type: "ai.chapter",
          projectId,
          profileId,
          chapterIds: [chapterId],
          tokenBudget: 10000,
        }),
      );
      expect((await finish(app, taskId)).status).toBe("failed");
      ok(await app.dispatch({ type: "file.backup", projectId }));
      const pack = JSON.parse(
        readFileSync(join(dir, "producer.novel"), "utf8"),
      );
      const t = pack.payload.tasks[0];
      const candidate = {
        chapterId,
        text: "候选文本",
        needsReview: false,
        checked: false,
      };
      if (malformation === "null request") t.requestSnapshot = null;
      if (malformation === "wrong command kind")
        t.requestSnapshot.command.type = "ai.check";
      if (malformation === "bad context documents")
        t.requestSnapshot.context.documents = {};
      if (malformation === "bad context source")
        t.requestSnapshot.context.documents[0].source = {
          kind: "unknown",
          id: projectId,
          revision: 1,
        };
      if (malformation === "bad context materials")
        t.requestSnapshot.context.materials = {};
      if (malformation === "nonarray candidates") t.result.candidates = {};
      if (malformation === "bad candidate text")
        t.result.candidates = [{ ...candidate, text: {} }];
      if (malformation === "bad candidate check")
        t.result.candidates = [
          {
            ...candidate,
            checked: true,
            check: { issues: {}, majorChange: false },
          },
        ];
      if (malformation === "nonarray materials") t.result.materials = {};
      if (malformation === "length phase without target") {
        t.result.phase = "length";
        t.result.candidates = [{ ...candidate, lengthAttempts: 1 }];
      }
      if (malformation === "length phase without pending candidate") {
        t.requestSnapshot.command.chapterWords = 250;
        t.result.phase = "length";
      }
      if (malformation === "wrong result discriminant")
        t.result.connection = true;
      if (malformation === "foreign candidate")
        t.result.candidates = [{ ...candidate, chapterId: "outside-chapter" }];
      if (malformation === "foreign version")
        t.result.candidates = [
          { ...candidate, versionId: pack.payload.versions[0].id },
        ];
      if (malformation === "foreign command owner")
        t.requestSnapshot.command.projectId = "another-project";
      pack.sha256 = createHash("sha256")
        .update(JSON.stringify(pack.payload))
        .digest("hex");
      selected = join(dir, "malformed.novel");
      writeFileSync(selected, JSON.stringify(pack));
      const before = app.snapshot();
      const result = await app.dispatch({ type: "file.importBackup" });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          code: "VALIDATION",
          message: expect.stringMatching(/[任务候选来源]/),
        });
      expect(app.snapshot()).toEqual(before);
    },
  );

  it.each(["running", "waiting"])(
    "opens local work while preserving a corrupt %s task record",
    async (status) => {
      const { app, projectId, dir } = setup();
      const url = await fixture((res) => {
        res.writeHead(401);
        res.end();
      });
      const profileId = model(app, url, "planning");
      const id = ok(
        await app.dispatch({
          type: "ai.plan",
          projectId,
          profileId,
          step: "outline",
          tokenBudget: 10000,
        }),
      );
      await finish(app, id);
      await app.dispose();
      apps.splice(apps.indexOf(app), 1);
      const db = new DatabaseSync(join(dir, "works.sqlite"));
      const task = JSON.parse(
        String(db.prepare("SELECT json FROM tasks WHERE id=?").get(id)!.json),
      );
      task.status = status;
      task.requestSnapshot = null;
      task.result = { candidates: {} };
      task.partial = "待恢复的原文";
      db.prepare("UPDATE tasks SET json=? WHERE id=?").run(
        JSON.stringify(task),
        id,
      );
      db.close();
      let reopened: AppServices | undefined;
      expect(() => {
        reopened = new AppServices({
          dataDir: dir,
          dialogs: { open: async () => null, save: async () => null },
        });
      }).not.toThrow();
      apps.push(reopened!);
      expect(reopened!.snapshot().tasks.find((t) => t.id === id)).toEqual(task);
      expect(reopened!.snapshot().projects[0].id).toBe(projectId);
      expect(
        (
          await reopened!.dispatch({
            type: "task.resume",
            id,
            mode: "continue",
          })
        ).ok,
      ).toBe(false);
    },
  );
});
