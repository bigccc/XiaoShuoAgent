// Isolated four-chapter acceptance using saved profiles, never production stories.
import { app, safeStorage } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServices } from "../src/main/services";
import type { CommandResult } from "../src/shared/types";

const directory = mkdtempSync(join(tmpdir(), "novel-writing-format-live-"));
app.setName("小说工坊");
app.setPath("userData", directory);
let services: AppServices | undefined, calls = 0;
const evidence: Record<string, unknown> = {
  date: new Date().toISOString(), isolated: true, productionModified: false,
  chapterCount: 4, targetWords: 3000, requestLimit: 18, tokenBudget: 200000,
};
const responses: unknown[] = [];
function id(r: CommandResult) { if (!r.ok) throw Error(r.error.message); return r.entityId; }
void app.whenReady().then(async () => {
  try {
    const db = new DatabaseSync(join(homedir(), "Library/Application Support/小说工坊/works.sqlite"), { readOnly: true });
    const profiles = db.prepare("SELECT p.json,c.ciphertext FROM profiles p JOIN credentials c ON c.profile_id=p.id WHERE json_extract(p.json,'$.purpose') IN ('writing','checking') ORDER BY p.rowid").all();
    db.close();
    if (!safeStorage.isEncryptionAvailable()) throw Error("系统密钥保护不可用");
    services = new AppServices({ dataDir: directory,
      credentials: { encrypt: x => safeStorage.encryptString(x), decrypt: x => safeStorage.decryptString(Buffer.from(x)) },
      dialogs: { open: async () => null, save: async () => null }, provider: { timeoutMs: 150000 },
      fetch: async (url, init) => {
        if (calls >= 18) throw Error("本次真实验证已到请求上限");
        calls++;
        const body = JSON.parse(String(init?.body));
        const phase = String(body.messages[0]?.content).split("。")[0];
        console.log(JSON.stringify({ event: "request", call: calls, phase }));
        const response = await fetch(url, init);
        const raw = await response.clone().text();
        let content = "", usage: unknown;
        for (const line of raw.split("\n")) if (line.startsWith("data:")) {
          try { const event = JSON.parse(line.slice(5).trim()); content += event.choices?.[0]?.delta?.content ?? ""; if (event.usage) usage = event.usage; } catch { /* DONE */ }
        }
        if (!content) { try { const result = JSON.parse(raw); content = result.choices?.[0]?.message?.content ?? ""; usage = result.usage; } catch { /* No raw transport data retained. */ } }
        let keys: string[] = [], flatMarker = false;
        try { const parsed = JSON.parse(content); keys = Object.keys(parsed); flatMarker = parsed.type === "json_object" && typeof parsed.title === "string"; } catch { /* Shape only. */ }
        responses.push({ phase, status: response.status, characters: content.length, keys, flatMarker, usage });
        console.log(JSON.stringify({ event: "response", call: calls, phase, characters: content.length, keys, flatMarker }));
        return response;
      },
    });
    const selected = new Set<string>();
    for (const row of profiles) {
      const profile = JSON.parse(String(row.json));
      if (selected.has(profile.purpose)) continue;
      if (new URL(profile.baseUrl).hostname !== "api.deepseek.com") throw Error("此脚本仅使用本机官方 DeepSeek 配置");
      selected.add(profile.purpose); evidence[`${profile.purpose}Model`] = profile.model;
      id(await services.dispatch({ type: "profile.save", name: `格式兼容验证 ${profile.purpose}`, purpose: profile.purpose, model: profile.model, baseUrl: profile.baseUrl, apiKey: safeStorage.decryptString(Buffer.from(row.ciphertext as Uint8Array)) }));
    }
    if (!selected.has("writing")) throw Error("缺少已保存写作模型");
    const projectId = id(await services.dispatch({ type: "project.create", title: "四章格式兼容验证", genre: "温暖日常", chapterWords: 3000,
      background: "现代小城。青年阿宁与师傅周叔经营修表铺，四章围绕修复邻居送来的旧座钟展开：接单检查、寻找配件、合作修复、交还旧钟。没有超自然能力、犯罪或复杂身世，不设置时间跳跃。" }));
    const jobId = id(await services.dispatch({ type: "conversation.send", projectId, text: "写完前四章，每章大约3000字", tokenBudget: 200000 }));
    const deadline = Date.now() + 10 * 60 * 1000;
    let progress = "";
    while (true) {
      const job = services.snapshot().writingJobs!.find(j => j.id === jobId)!;
      const next = JSON.stringify({ status: job.status, phase: job.phase, cursor: job.cursor, saved: job.chapters.filter(c => c.chapterId).length });
      if (next !== progress) { progress = next; console.log(progress); }
      if (job.status !== "running") break;
      if (Date.now() > deadline) { await services.dispatch({ type: "writing.pause", id: jobId }); break; }
      await new Promise(r => setTimeout(r, 500));
    }
    const job = services.snapshot().writingJobs!.find(j => j.id === jobId)!;
    evidence.result = { status: job.status, phase: job.phase, calls: job.calls, usage: job.usage, budgetUsed: job.budgetUsed,
      chapters: job.chapters.map(c => ({ ordinal: c.ordinal, status: c.status, revisionRounds: c.revisionRounds, words: c.chapterId ? services!.chapter(c.chapterId).content.replace(/\s/g, "").length : 0 })),
      issues: job.issues.map(i => ({ category: i.category, impact: i.impact })), error: job.error };
    evidence.workflowCompleted = job.phase === "done" && job.chapters.every(c => ["checked", "needs-review"].includes(c.status));
    evidence.qualityPassed = job.status === "completed";
    if (!evidence.workflowCompleted) process.exitCode = 1;
  } catch (e) { evidence.error = e instanceof Error ? e.message : "验证失败"; process.exitCode = 1; }
  finally {
    evidence.liveCalls = calls; evidence.responses = responses;
    await services?.dispose();
    writeFileSync(resolve("docs/writing-format-live-20261016.json"), JSON.stringify(evidence, null, 2) + "\n");
    rmSync(directory, { recursive: true, force: true }); app.quit();
  }
});
