import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageSyncService } from "../src/main/stage-sync";
import { AppServices } from "../src/main/services";
import { Store } from "../src/main/store";
import { ProjectFiles } from "../src/main/files";
import type { Command, CommandResult } from "../src/shared/types";
const apps: AppServices[] = [],
  dirs: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.dispose()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function id(r: CommandResult) {
  if (!r.ok) throw Error(r.error.message);
  return r.entityId;
}
function setup(handler: (request: any) => any | Promise<any>, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "novel-sync-"));
  dirs.push(dir);
  const app = new AppServices({
    dataDir: dir,
    dialogs: { open: async () => null, save: async () => null },
    fetch: async (_url, init) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  await handler(JSON.parse(String(init!.body))),
                ),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    ...extra,
  });
  apps.push(app);
  const projectId = id(
    app.domain.execute({ type: "project.create", title: "同步小说" }),
  );
  id(
    app.domain.execute({
      type: "profile.save",
      name: "同步模型",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "fixture",
      purpose: "writing",
    }),
  );
  return { app, projectId };
}
async function send(app: AppServices, projectId: string, text = "生成设定") {
  const tid = id(
    await app.dispatch({ type: "conversation.send", projectId, text }),
  );
  await expect
    .poll(() => app.snapshot().conversations.find((t) => t.id === tid)!.status)
    .not.toBe("running");
  return app.snapshot().conversations.find((t) => t.id === tid)!;
}
const settings = {
  message: "设定准备好了",
  artifacts: [
    {
      stage: "settings",
      blocks: [
        { kind: "field", field: "style", text: "轻松幽默" },
        { kind: "field", field: "pace", text: "逐步揭谜" },
        {
          kind: "note",
          noteType: "character",
          title: "林舟",
          text: "遗物整理师，怕黑",
        },
        {
          kind: "note",
          noteType: "world",
          title: "雾港规则",
          text: "没有时间旅行",
        },
        {
          kind: "note",
          noteType: "location",
          title: "旧邮局",
          text: "在港口北侧",
        },
        {
          kind: "note",
          noteType: "supplement",
          title: "补充说明",
          text: "叙事留白，不解释所有传闻",
        },
      ],
    },
  ],
};

it("commits structured settings and auxiliary records as one canonical version, including supplements", async () => {
  const { app, projectId } = setup(() => settings);
  expect((await send(app, projectId)).status).toBe("completed");
  const s = app.snapshot(),
    p = s.projects[0],
    doc = p.authoring!.documents.settings!;
  expect(p.style).toBe("轻松幽默");
  expect(p.pace).toBe("逐步揭谜");
  expect(s.notes.filter((n) => !n.archived).map((n) => n.type)).toEqual([
    "character",
    "world",
    "location",
    "supplement",
  ]);
  for (const note of s.notes) expect(doc.content).toContain(note.body);
  expect(doc.sync!.status).toBe("synced");
  expect(doc.sync!.bindings).toHaveLength(6);
  expect(s.syncBatches).toHaveLength(1);
  expect(s.syncJobs[0].status).toBe("succeeded");
  expect(p.targetWords).toBe(100000);
});

it("reverse editing and renaming keep note identities and project fields aligned without another model call", async () => {
  let calls = 0;
  const { app, projectId } = setup(() => {
    calls++;
    return settings;
  });
  await send(app, projectId);
  const n = app.snapshot().notes.find((n) => n.type === "character")!;
  id(
    await app.dispatch({
      type: "note.save",
      id: n.id,
      revision: n.revision,
      projectId,
      noteType: n.type,
      title: "林溪",
      body: "保险调查员，怕黑",
      sources: [],
    }),
  );
  let p = app.snapshot().projects[0];
  expect(p.authoring!.documents.settings!.content).toContain("林溪");
  expect(p.authoring!.documents.settings!.content).toContain("保险调查员");
  expect(
    app.snapshot().notes.filter((n) => n.type === "character"),
  ).toHaveLength(1);
  id(
    await app.dispatch({
      type: "project.update",
      id: p.id,
      revision: p.revision,
      patch: { style: "温柔克制" },
    }),
  );
  p = app.snapshot().projects[0];
  expect(p.authoring!.documents.settings!.content).toContain("温柔克制");
  expect(calls).toBe(1);
});

it("normalizes free edits and exposes conflicts instead of overwriting independently edited records", async () => {
  let normalizationCalls = 0;
  const { app, projectId } = setup((req) => {
    if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
      normalizationCalls++;
      const data = JSON.parse(req.messages.at(-1).content);
      return {
        stage: "settings",
        blocks: [
          {
            kind: "note",
            noteId: data.notes.find((n: any) => n.type === "character").id,
            noteType: "character",
            title: "林舟",
            startLine: 1,
            endLine: data.text.split("\n").length,
          },
        ],
        removeNoteIds: data.bindings
          .filter((b: any) => b.kind === "note")
          .map((b: any) => b.noteId)
          .filter(
            (v: string) =>
              v !== data.notes.find((n: any) => n.type === "character").id,
          ),
      };
    }
    return settings;
  });
  await send(app, projectId);
  const p = app.snapshot().projects[0],
    n = app.snapshot().notes.find((n) => n.type === "character")!;
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "林舟现在是保险调查员。",
    }),
  );
  id(
    await app.dispatch({
      type: "note.save",
      id: n.id,
      revision: n.revision,
      projectId,
      noteType: "character",
      title: n.title,
      body: "作者在辅助工具写下的职业",
      sources: [],
    }),
  );
  const doc = app.snapshot().projects[0].authoring!.documents.settings!;
  expect(doc.content).toBe("林舟现在是保险调查员。");
  expect(doc.sync!.status).toBe("conflict");
  expect(app.snapshot().notes.find((x) => x.id === n.id)!.body).toBe(
    "作者在辅助工具写下的职业",
  );
  const jobId = id(
    await app.dispatch({
      type: "authoring.sync",
      projectId,
      stage: "settings",
    }),
  );
  await expect
    .poll(() => app.snapshot().syncJobs.find((j) => j.id === jobId)!.status)
    .toBe("conflict");
  id(
    await app.dispatch({
      type: "authoring.resolveSync",
      id: jobId,
      resolution: "records",
    }),
  );
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toContain("作者在辅助工具");
  expect(normalizationCalls).toBeLessThanOrEqual(1);
});

it("archives removed managed notes, keeps independent notes and can restore stage history", async () => {
  let output: any = settings;
  const { app, projectId } = setup(() => output);
  await send(app, projectId);
  const p = app.snapshot().projects[0],
    oldRevision = p.authoring!.documents.settings!.revision;
  const n = app.snapshot().notes.find((n) => n.type === "character")!;
  id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "独立人物",
      body: "作者的独立笔记",
      sources: [],
    }),
  );
  output = {
    message: "移除角色",
    artifacts: [
      {
        stage: "settings",
        blocks: [{ kind: "field", field: "style", text: "轻松幽默" }],
        removeNoteIds: app
          .snapshot()
          .notes.filter((x) => x.syncManaged)
          .map((x) => x.id),
      },
    ],
  };
  expect(
    (await send(app, projectId, "重写设定，移除当前人物和世界记录")).status,
  ).toBe("completed");
  expect(app.snapshot().notes.find((x) => x.id === n.id)!.archived).toBe(true);
  expect(
    app.snapshot().notes.find((x) => x.title === "独立人物")!.archived,
  ).not.toBe(true);
  const current = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.restore",
      projectId,
      stage: "settings",
      revision: current.revision,
      historyRevision: oldRevision,
    }),
  );
  expect(app.snapshot().notes.find((x) => x.id === n.id)!.archived).not.toBe(
    true,
  );
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toContain("遗物整理师");
});

it("merges rapid local saves into one five-second scheduled normalization of the latest revision", async () => {
  let normalizations = 0;
  const { app, projectId } = setup(
    (req) => {
      if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
        normalizations++;
        const data = JSON.parse(req.messages.at(-1).content);
        return {
          stage: "settings",
          blocks: [{ kind: "field", field: "style", startLine: 1, endLine: 1 }],
          removeNoteIds: [],
        };
      }
      return {
        message: "风格",
        artifacts: [
          {
            stage: "settings",
            blocks: [{ kind: "field", field: "style", text: "原文风" }],
          },
        ],
      };
    },
    { syncDebounceMs: 50 },
  );
  await send(app, projectId);
  for (const content of ["新文风甲", "新文风乙", "最新文风"]) {
    const p = app.snapshot().projects[0];
    id(
      await app.dispatch({
        type: "authoring.save",
        id: projectId,
        revision: p.revision,
        stage: "settings",
        content,
      }),
    );
  }
  await expect
    .poll(
      () =>
        app.snapshot().projects[0].authoring!.documents.settings!.sync!.status,
    )
    .toBe("synced");
  expect(app.snapshot().projects[0].style).toBe("最新文风");
  expect(normalizations).toBe(1);
});

it("rejects stale normalization and incomplete source-line coverage without applying partial changes", async () => {
  let release!: () => void, source: any;
  const { app, projectId } = setup(async (req) => {
    if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
      source = JSON.parse(req.messages.at(-1).content);
      await new Promise<void>((r) => {
        release = r;
      });
      return {
        stage: "settings",
        blocks: [{ kind: "field", field: "style", startLine: 1, endLine: 1 }],
      };
    }
    return {
      message: "风格",
      artifacts: [
        {
          stage: "settings",
          blocks: [{ kind: "field", field: "style", text: "原文风" }],
        },
      ],
    };
  });
  await send(app, projectId);
  let p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "正在整理\n不能丢掉的补充",
    }),
  );
  const jobId = id(
    await app.dispatch({
      type: "authoring.sync",
      projectId,
      stage: "settings",
    }),
  );
  await expect.poll(() => !!release).toBe(true);
  p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "作者更新后的全文",
    }),
  );
  release();
  await expect
    .poll(() => app.snapshot().syncJobs.find((j) => j.id === jobId)!.status)
    .not.toBe("running");
  expect(app.snapshot().projects[0].style).toBe("原文风");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toBe("作者更新后的全文");
  expect(source.text).toContain("不能丢掉");
});

it("repairs missing source coverage only once and blocks advancement on failed sync", async () => {
  let calls = 0;
  const { app, projectId } = setup((req) => {
    if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
      calls++;
      return {
        stage: "settings",
        blocks: [{ kind: "field", field: "style", startLine: 1, endLine: 1 }],
      };
    }
    return {
      message: "文风",
      artifacts: [
        {
          stage: "settings",
          blocks: [{ kind: "field", field: "style", text: "原文风" }],
        },
      ],
    };
  });
  await send(app, projectId);
  const p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "新文风\n必须保留的补充",
    }),
  );
  const jobId = id(
    await app.dispatch({
      type: "authoring.sync",
      projectId,
      stage: "settings",
    }),
  );
  await expect
    .poll(() => app.snapshot().syncJobs.find((j) => j.id === jobId)!.status)
    .toBe("failed");
  expect(calls).toBe(2);
  expect(app.snapshot().projects[0].style).toBe("原文风");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toContain("必须保留");
  expect(
    await app.dispatch({ type: "conversation.send", projectId, text: "继续" }),
  ).toMatchObject({ ok: false });
  expect(app.snapshot().projects[0].authoring!.activeStage).toBe("settings");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.approved,
  ).toBe(false);
});

it("stopping inline normalization prevents late generation adoption and retains its draft", async () => {
  let release!: () => void;
  const { app, projectId } = setup(async (req) => {
    if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
      await new Promise<void>((r) => {
        release = r;
      });
      return {
        stage: "settings",
        blocks: [{ kind: "field", field: "style", startLine: 1, endLine: 1 }],
      };
    }
    return {
      message: "准备设定",
      artifacts: [{ stage: "settings", content: "不能丢掉的原设定" }],
    };
  });
  const tid = id(
    await app.dispatch({
      type: "conversation.send",
      projectId,
      text: "生成设定",
    }),
  );
  await expect.poll(() => !!release).toBe(true);
  const jobId = app.snapshot().syncJobs.at(-1)!.id;
  id(await app.dispatch({ type: "authoring.cancelSync", id: jobId }));
  release();
  await expect
    .poll(() => app.snapshot().conversations.find((t) => t.id === tid)!.status)
    .not.toBe("running");
  expect(app.snapshot().syncJobs.find((j) => j.id === jobId)!.status).toBe(
    "cancelled",
  );
  expect(app.snapshot().projects[0].style).toBe("");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toBe("不能丢掉的原设定");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.status,
  ).toBe("pending");
});

it("refuses cross-project record references and preserves first-association manual differences", async () => {
  let output: any = settings;
  const { app, projectId } = setup(() => output);
  const other = id(
    app.domain.execute({ type: "project.create", title: "另一部" }),
  );
  const foreign = id(
    app.domain.execute({
      type: "note.save",
      projectId: other,
      noteType: "character",
      title: "林舟",
      body: "其他作品",
      sources: [],
    }),
  );
  output = {
    message: "越权关联",
    artifacts: [
      {
        stage: "settings",
        blocks: [
          {
            kind: "note",
            noteId: foreign,
            noteType: "character",
            title: "林舟",
            text: "不应更新",
          },
        ],
      },
    ],
  };
  expect((await send(app, projectId)).status).toBe("failed");
  expect(app.snapshot().notes.find((n) => n.id === foreign)!.body).toBe(
    "其他作品",
  );
  const own = id(
    app.domain.execute({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "林舟",
      body: "作者的原人物设定",
      sources: [],
    }),
  );
  output = {
    message: "准备新方案",
    artifacts: [
      {
        stage: "settings",
        blocks: [
          {
            kind: "note",
            noteId: own,
            noteType: "character",
            title: "林舟",
            text: "AI建议的不同设定",
          },
        ],
      },
    ],
  };
  expect((await send(app, projectId)).status).toBe("failed");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.status,
  ).toBe("conflict");
  expect(app.snapshot().notes.find((n) => n.id === own)!.body).toBe(
    "作者的原人物设定",
  );
  const jobId =
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.jobId!;
  id(
    await app.dispatch({
      type: "authoring.resolveSync",
      id: jobId,
      resolution: "records",
    }),
  );
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toContain("作者的原人物设定");
});

it("waits the default five seconds and stores only the latest rapid edit", async () => {
  let count = 0;
  const { app, projectId } = setup((req) => {
    if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
      count++;
      return {
        stage: "settings",
        blocks: [{ kind: "field", field: "style", startLine: 1, endLine: 1 }],
      };
    }
    return {
      message: "文风",
      artifacts: [
        {
          stage: "settings",
          blocks: [{ kind: "field", field: "style", text: "原文风" }],
        },
      ],
    };
  });
  await send(app, projectId);
  vi.useFakeTimers();
  try {
    let p = app.snapshot().projects[0];
    id(
      await app.dispatch({
        type: "authoring.save",
        id: projectId,
        revision: p.revision,
        stage: "settings",
        content: "第一版",
      }),
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect(count).toBe(0);
    p = app.snapshot().projects[0];
    id(
      await app.dispatch({
        type: "authoring.save",
        id: projectId,
        revision: p.revision,
        stage: "settings",
        content: "最新版",
      }),
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(count).toBe(1);
    expect(app.snapshot().projects[0].style).toBe("最新版");
  } finally {
    vi.useRealTimers();
  }
});

it("updates every synced view of a shared supplement and only unlinks it when another stage still refers to it", async () => {
  let output: any = {
    message: "共用规则",
    artifacts: [
      {
        stage: "settings",
        blocks: [
          {
            kind: "note",
            noteType: "supplement",
            title: "公共补充",
            text: "共用设定",
          },
        ],
      },
    ],
  };
  const { app, projectId } = setup((req) => {
    if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
      const data = JSON.parse(req.messages.at(-1).content);
      return {
        stage: "settings",
        blocks: [
          {
            kind: "note",
            noteId: data.notes[0].id,
            noteType: "supplement",
            title: "公共补充",
            startLine: 1,
            endLine: data.lineCount,
          },
        ],
      };
    }
    return output;
  });
  await send(app, projectId);
  const nid = app.snapshot().notes[0].id;
  output = {
    message: "大纲引用",
    artifacts: [
      {
        stage: "outline",
        blocks: [
          {
            kind: "note",
            noteId: nid,
            noteType: "supplement",
            title: "公共补充",
            text: "共用设定",
          },
        ],
      },
    ],
  };
  expect((await send(app, projectId, "生成大纲")).status).toBe("completed");
  let p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "## 公共补充\n新的共用设定",
    }),
  );
  const job = id(
    await app.dispatch({
      type: "authoring.sync",
      projectId,
      stage: "settings",
    }),
  );
  await expect
    .poll(() => app.snapshot().syncJobs.find((j) => j.id === job)!.status)
    .toBe("succeeded");
  p = app.snapshot().projects[0];
  expect(p.authoring!.documents.outline!.content).toContain("新的共用设定");
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "",
    }),
  );
  const empty = id(
    await app.dispatch({
      type: "authoring.sync",
      projectId,
      stage: "settings",
    }),
  );
  await expect
    .poll(() => app.snapshot().syncJobs.find((j) => j.id === empty)!.status)
    .toBe("succeeded");
  expect(app.snapshot().notes.find((n) => n.id === nid)!.archived).not.toBe(
    true,
  );
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.bindings,
  ).toHaveLength(0);
});

it("moves a bound note between stage categories through auxiliary editing without a model call", async () => {
  let calls = 0;
  const { app, projectId } = setup(() => {
    calls++;
    return settings;
  });
  await send(app, projectId);
  const n = app.snapshot().notes.find((n) => n.type === "character")!;
  id(
    await app.dispatch({
      type: "note.save",
      id: n.id,
      revision: n.revision,
      projectId,
      noteType: "outline",
      title: "人物成长线",
      body: "从逃避到调查父亲",
      sources: [],
    }),
  );
  const p = app.snapshot().projects[0];
  expect(
    p.authoring!.documents.settings!.sync!.bindings.some(
      (b) => b.noteId === n.id,
    ),
  ).toBe(false);
  expect(
    p.authoring!.documents.outline!.sync!.bindings.some(
      (b) => b.noteId === n.id,
    ),
  ).toBe(true);
  expect(p.authoring!.documents.outline!.content).toContain("从逃避到调查父亲");
  expect(calls).toBe(1);
});

it("keeps pending raw draft history distinct from canonical batch history", async () => {
  const { app, projectId } = setup(() => ({
    message: "文风",
    artifacts: [
      {
        stage: "settings",
        blocks: [{ kind: "field", field: "style", text: "原文风" }],
      },
    ],
  }));
  await send(app, projectId);
  let p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "尚未整理的甲版",
    }),
  );
  const rawRevision =
    app.snapshot().projects[0].authoring!.documents.settings!.revision;
  p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "尚未整理的乙版",
    }),
  );
  const h = app
    .snapshot()
    .projects[0].authoring!.documents.settings!.history.find(
      (h) => h.revision === rawRevision,
    )!;
  expect(h.content).toBe("尚未整理的甲版");
  expect(h.batchId).toBeUndefined();
  p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.restore",
      projectId,
      stage: "settings",
      revision: p.revision,
      historyRevision: rawRevision,
    }),
  );
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toBe("尚未整理的甲版");
  expect(app.snapshot().projects[0].style).toBe("原文风");
});

it("keeps unrelated edits out of conflicts and backups portable after independent record deletion", async () => {
  const { app, projectId } = setup(() => settings);
  await send(app, projectId);
  const independent = id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "world",
      title: "独立记录",
      body: "保留独立性",
      sources: [],
    }),
  );
  const p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "尚未整理的新全文",
    }),
  );
  id(
    await app.dispatch({
      type: "note.save",
      projectId,
      noteType: "location",
      title: "另一个独立记录",
      body: "与全文绑定无关",
      sources: [],
    }),
  );
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.status,
  ).toBe("pending");
  const n = app.snapshot().notes.find((n) => n.id === independent)!;
  id(
    await app.dispatch({ type: "note.delete", id: n.id, revision: n.revision }),
  );
  const dir = dirs.at(-1)!;
  await app.dispose();
  const store = new Store(join(dir, "works.sqlite"));
  try {
    const files = new ProjectFiles(store),
      path = join(dir, "after-delete.novel");
    await files.backup(projectId, path);
    await expect(files.importBackup(path)).resolves.toBeTruthy();
  } finally {
    store.close();
  }
});

it("keeps block identities when repeated generation omits IDs", async () => {
  const { app, projectId } = setup(() => settings);
  expect((await send(app, projectId)).status).toBe("completed");
  const first =
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.bindings;
  expect((await send(app, projectId, "重新生成设定")).status).toBe("completed");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.bindings,
  ).toEqual(first);
});
it("rejects stale conflict resolution after an unbound candidate changes", async () => {
  let noteId = "";
  const { app, projectId } = setup(() => ({
    message: "设定",
    artifacts: [
      {
        stage: "settings",
        blocks: [
          {
            kind: "note",
            noteType: "character",
            noteId,
            title: "林舟",
            text: "AI建议",
          },
        ],
      },
    ],
  }));
  noteId = id(
    app.domain.execute({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "林舟",
      body: "手工旧文",
      sources: [],
    }),
  );
  expect((await send(app, projectId)).status).toBe("failed");
  const jobId =
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.jobId!;
  const n = app.snapshot().notes.find((n) => n.id === noteId)!;
  id(
    await app.dispatch({
      type: "note.save",
      projectId,
      id: noteId,
      revision: n.revision,
      noteType: "character",
      title: n.title,
      body: "后续新手工文",
      sources: [],
    }),
  );
  expect(
    (
      await app.dispatch({
        type: "authoring.resolveSync",
        id: jobId,
        resolution: "draft",
      })
    ).ok,
  ).toBe(false);
  expect(app.snapshot().notes.find((n) => n.id === noteId)!.body).toBe(
    "后续新手工文",
  );
});
it("preserves earlier structured output and finalizes jobs when a later artifact fails", async () => {
  const { app, projectId } = setup(() => settings);
  const captured = app.snapshot();
  const profile = captured.profiles[0].id;
  await expect(
    (app as unknown as { sync: StageSyncService }).sync.prepareGenerated(
      {
        message: "成果",
        artifacts: [
          settings.artifacts[0] as any,
          {
            stage: "outline",
            blocks: [
              {
                kind: "note",
                noteType: "storyline",
                noteId: "unknown",
                title: "主线",
                text: "不能引用",
              },
            ],
          },
        ],
      },
      captured,
      projectId,
      profile,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(app.snapshot().syncJobs.every((j) => j.status !== "running")).toBe(
    true,
  );
  const first = app.snapshot().syncJobs.find((j) => j.stage === "settings")!;
  expect(first.sourceContent).toContain("遗物整理师");
  expect(first.proposal!.blocks).toHaveLength(6);
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toContain("遗物整理师");
  expect(app.snapshot().notes).toHaveLength(0);
});
it("rejects contradictory shared-note values in a generated cohort atomically", async () => {
  const { app, projectId } = setup(() => settings);
  expect((await send(app, projectId)).status).toBe("completed");
  const note = app.snapshot().notes.find((n) => n.type === "supplement")!;
  const captured = app.snapshot();
  const prepared = await (
    app as unknown as { sync: StageSyncService }
  ).sync.prepareGenerated(
    {
      message: "更新",
      artifacts: [
        {
          stage: "settings",
          blocks: [
            {
              kind: "note",
              noteType: "supplement",
              noteId: note.id,
              title: note.title,
              text: "B",
            },
          ],
          removeNoteIds:
            captured.projects[0].authoring!.documents.settings!.sync!.bindings.flatMap(
              (b) => (b.noteId && b.noteId !== note.id ? [b.noteId] : []),
            ),
        },
        {
          stage: "outline",
          blocks: [
            {
              kind: "note",
              noteType: "supplement",
              noteId: note.id,
              title: note.title,
              text: "C",
            },
          ],
        },
      ],
    },
    captured,
    projectId,
    captured.profiles[0].id,
    new AbortController().signal,
  );
  expect(() =>
    (app as unknown as { sync: StageSyncService }).sync.commitGenerated(
      projectId,
      prepared,
      captured.projects[0].authoring!,
    ),
  ).toThrow();
  expect(app.snapshot().notes.find((n) => n.id === note.id)!.body).toBe(
    note.body,
  );
});

it("renormalizes the latest draft instead of rebaselining an obsolete conflict proposal", async () => {
  let noteId = "";
  const { app, projectId } = setup((req) =>
    req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")
      ? {
          stage: "settings",
          blocks: [
            {
              kind: "note",
              noteType: "character",
              noteId,
              title: "林舟",
              startLine: 1,
              endLine: 1,
              heading: false,
            },
          ],
        }
      : {
          message: "设定",
          artifacts: [
            {
              stage: "settings",
              blocks: [
                {
                  kind: "note",
                  noteType: "character",
                  noteId,
                  title: "林舟",
                  text: "AI旧建议",
                },
              ],
            },
          ],
        },
  );
  noteId = id(
    app.domain.execute({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "林舟",
      body: "原资料",
      sources: [],
    }),
  );
  await send(app, projectId);
  let p = app.snapshot().projects[0];
  const jobId = p.authoring!.documents.settings!.sync!.jobId!;
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "settings",
      content: "作者最新草稿",
    }),
  );
  expect(
    (
      await app.dispatch({
        type: "authoring.resolveSync",
        id: jobId,
        resolution: "draft",
      })
    ).ok,
  ).toBe(false);
  const next = id(
    await app.dispatch({
      type: "authoring.resolveSync",
      id: jobId,
      resolution: "draft",
    }),
  );
  await expect
    .poll(() => app.snapshot().syncJobs.find((j) => j.id === next)!.status)
    .toBe("succeeded");
  expect(
    app.snapshot().projects[0].authoring!.documents.settings!.content,
  ).toBe("作者最新草稿");
  expect(app.snapshot().notes[0].body).toBe("作者最新草稿");
});
it("detects shared targets implicitly reused by exact matching before cohort commits", async () => {
  const { app, projectId } = setup(() => settings);
  await send(app, projectId);
  const captured = app.snapshot(),
    n = captured.notes.find((n) => n.type === "supplement")!;
  const sync = (app as unknown as { sync: StageSyncService }).sync;
  const prepared = await sync.prepareGenerated(
    {
      message: "更新",
      artifacts: [
        {
          stage: "settings",
          blocks: [
            {
              kind: "note",
              noteType: "supplement",
              title: n.title,
              text: n.body,
            },
          ],
          removeNoteIds: captured.notes
            .filter((x) => x.id !== n.id)
            .map((x) => x.id),
        },
        {
          stage: "outline",
          blocks: [
            {
              kind: "note",
              noteType: "supplement",
              noteId: n.id,
              title: n.title,
              text: "不同的新内容",
            },
          ],
        },
      ],
    },
    captured,
    projectId,
    captured.profiles[0].id,
    new AbortController().signal,
  );
  expect(() =>
    sync.commitGenerated(projectId, prepared, captured.projects[0].authoring!),
  ).toThrow();
  expect(app.snapshot().notes.find((x) => x.id === n.id)!.body).toBe(n.body);
});
it("renames a stable block using its binding even when the model omits noteId", async () => {
  let output: any = settings;
  const { app, projectId } = setup(() => output);
  await send(app, projectId);
  const before = app.snapshot(),
    binding =
      before.projects[0].authoring!.documents.settings!.sync!.bindings.find(
        (b) =>
          b.noteId === before.notes.find((n) => n.type === "character")!.id,
      )!;
  output = structuredClone(settings);
  output.artifacts[0].blocks[2] = {
    ...output.artifacts[0].blocks[2],
    id: binding.id,
    title: "林远",
    text: "新名字仍是同一人",
  };
  expect((await send(app, projectId, "修改人物名")).status).toBe("completed");
  expect(app.snapshot().notes.find((n) => n.title === "林远")!.id).toBe(
    binding.noteId,
  );
  expect(app.snapshot().notes).toHaveLength(before.notes.length);
});

it("organizes a legacy planning reply that omits artifacts before marking the turn complete", async () => {
  let normalized = 0;
  const { app, projectId } = setup((req) => {
    if (req.messages[0].content.includes("STAGE_SYNC_NORMALIZE")) {
      normalized++;
      return {
        stage: "overview",
        blocks: [
          { kind: "field", field: "title", startLine: 1, endLine: 2 },
          { kind: "field", field: "genre", startLine: 4, endLine: 5 },
          { kind: "field", field: "background", startLine: 7, endLine: 8 },
          {
            kind: "note",
            noteType: "supplement",
            title: "梗概",
            startLine: 10,
            endLine: 11,
          },
        ],
      };
    }
    return {
      message: "概要好了",
      project: { title: "旧信", genre: "悬疑", background: "父子寻找骗局真相" },
      notes: [
        { type: "storyline", title: "梗概", body: "最终公开真相与父亲和解。" },
      ],
    };
  });
  const turn = await send(app, projectId, "请生成概要");
  expect(turn.status).toBe("completed");
  expect(normalized).toBe(0);
  const p = app.snapshot().projects[0],
    d = p.authoring!.documents.overview!;
  expect(d.sync!.status).toBe("synced");
  expect(d.content).toContain("最终公开真相");
  expect(p.title).toBe("旧信");
  expect(p.genre).toBe("悬疑");
  expect(app.snapshot().notes.some((n) => n.type === "storyline")).toBe(false);
});

it("retains explicit identities while organizing mixed legacy rename/new-record replies", async () => {
  let noteId = "";
  const { app, projectId } = setup(() => ({
    message: "设定",
    notes: [
      { id: noteId, type: "character", title: "林远", body: "新版人物" },
      { type: "location", title: "街道", body: "港口旧街" },
    ],
  }));
  noteId = id(
    app.domain.execute({
      type: "note.save",
      projectId,
      noteType: "character",
      title: "林舟",
      body: "旧人物",
      sources: [],
    }),
  );
  expect((await send(app, projectId, "生成设定")).status).toBe("failed");
  const job =
    app.snapshot().projects[0].authoring!.documents.settings!.sync!.jobId!;
  id(
    await app.dispatch({
      type: "authoring.resolveSync",
      id: job,
      resolution: "draft",
    }),
  );
  expect(app.snapshot().notes.find((n) => n.id === noteId)!.title).toBe("林远");
  expect(
    app.snapshot().notes.filter((n) => n.type === "character"),
  ).toHaveLength(1);
  expect(
    app
      .snapshot()
      .notes.some((n) => n.type === "location" && n.body === "港口旧街"),
  ).toBe(true);
});
it("retains invalid removal references only in raw model history", async () => {
  const { app, projectId } = setup(() => ({
    message: "设定",
    artifacts: [
      {
        stage: "settings",
        blocks: [{ kind: "field", field: "style", text: "白描" }],
        removeNoteIds: ["unknown-record"],
      },
    ],
  }));
  const turn = await send(app, projectId);
  expect(turn.status).toBe("failed");
  expect(turn.response).toBeUndefined();
  expect(turn.rawResponse).toContain("unknown-record");
});

it("accepts null placeholders for unused optional fields without relaxing required stage data", async () => {
  const { app, projectId } = setup(() => ({
    message: "概要",
    artifacts: [
      {
        stage: "overview",
        blocks: [
          { kind: "field", field: "title", text: "旧信" },
          { kind: "field", field: "genre", text: "悬疑" },
          { kind: "field", field: "background", text: "父子公开骗局真相。" },
        ],
      },
    ],
    notes: [],
    chapters: [],
    proposal: null,
  }));
  const turn = await send(app, projectId, "生成概要");
  expect(turn.status).toBe("completed");
  expect(
    app.snapshot().projects[0].authoring!.documents.overview!.sync!.status,
  ).toBe("synced");
  expect(turn.response!.proposal).toBeUndefined();
  expect(turn.rawResponse).toContain('"proposal":null');
});

it("numbers blank and CRLF source lines and identifies omitted lines in the one repair request", async () => {
  let calls = 0;
  const { app, projectId } = setup((req) => {
    const data = JSON.parse(req.messages[1].content);
    calls++;
    expect(data.lines).toEqual([
      { number: 1, text: "事实甲" },
      { number: 2, text: "" },
      { number: 3, text: "事实乙" },
      { number: 4, text: "结局丙" },
    ]);
    if (calls === 2) expect(req.messages[0].content).toContain("3,4");
    return {
      stage: "overview",
      blocks: [
        {
          kind: "field",
          field: "background",
          startLine: 1,
          endLine: calls === 1 ? 1 : 4,
        },
      ],
    };
  });
  const p = app.snapshot().projects[0];
  id(
    await app.dispatch({
      type: "authoring.save",
      id: projectId,
      revision: p.revision,
      stage: "overview",
      content: "事实甲\r\n\r\n事实乙\r\n结局丙",
    }),
  );
  const job = id(
    await app.dispatch({
      type: "authoring.sync",
      projectId,
      stage: "overview",
    }),
  );
  await expect
    .poll(() => app.snapshot().syncJobs.find((j) => j.id === job)!.status)
    .toBe("succeeded");
  expect(calls).toBe(2);
  expect(app.snapshot().projects[0].background).toBe(
    "事实甲\n\n事实乙\n结局丙",
  );
});
