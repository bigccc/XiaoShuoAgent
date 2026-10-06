import { afterEach, describe, expect, it } from "vitest";
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
    const url = await fixture((res, b) => {
      calls++;
      prompts.push(JSON.stringify(b.messages));
      if (calls === 1) reply(res, "第一章候选");
      else if (calls === 2)
        reply(res, JSON.stringify({ issues: [], majorChange: false }));
      else if (calls === 3) reply(res, "第二章候选");
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
    expect(calls).toBe(4);
    expect(prompts[2]).toContain("第一章候选");
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
    const url = await fixture((res, b) => {
      calls++;
      maxLength = Math.max(maxLength, JSON.stringify(b.messages).length);
      if (calls % 2) reply(res, `批次候选${calls} ` + "正文".repeat(2500));
      else if (calls === 4) {
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
    expect(task.status).toBe("awaiting-author");
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
});
