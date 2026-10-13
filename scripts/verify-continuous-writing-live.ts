// Isolated live acceptance: read the existing protected profile, never production stories.
import { app, safeStorage } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServices } from "../src/main/services";
import type { CommandResult } from "../src/shared/types";

const directory = mkdtempSync(join(tmpdir(), "novel-continuous-live-"));
app.setName("小说工坊"); app.setPath("userData", directory);
let services: AppServices | undefined, calls = 0;
const diagnostics: unknown[] = [];
const evidence: Record<string, unknown> = { date: new Date().toISOString(), isolated: true, productionModified: false, requestLimit: 28, outputCap: 4000, tokenBudget: 100000 };
function id(r: CommandResult) { if (!r.ok) throw Error(r.error.message); return r.entityId; }
void app.whenReady().then(async () => {
  try {
    const db = new DatabaseSync(join(homedir(), "Library/Application Support/小说工坊/works.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT p.json,c.ciphertext FROM profiles p JOIN credentials c ON c.profile_id=p.id WHERE json_extract(p.json,'$.purpose')='writing'").get();
    const checkingRow = db.prepare("SELECT p.json,c.ciphertext FROM profiles p JOIN credentials c ON c.profile_id=p.id WHERE json_extract(p.json,'$.purpose')='checking'").get();
    db.close();
    if (!row) throw Error("缺少已保存的写作模型");
    const profile = JSON.parse(String(row.json));
    if (new URL(profile.baseUrl).hostname !== "api.deepseek.com") throw Error("此验证仅使用本机官方DeepSeek配置");
    if (!safeStorage.isEncryptionAvailable()) throw Error("系统密钥保护不可用");
    evidence.model = profile.model;
    services = new AppServices({ dataDir: directory, credentials: { encrypt: x => safeStorage.encryptString(x), decrypt: x => safeStorage.decryptString(Buffer.from(x)) }, dialogs: { open: async () => null, save: async () => null }, provider: { timeoutMs: 90000 },
      fetch: async (url, init) => {
        if (calls >= 28) throw Error("真实请求已达到本次验证上限");
        calls++;
        const body = JSON.parse(String(init?.body)); body.max_tokens = Math.min(body.max_tokens, 4000);
        console.log(`[live] 请求 ${calls}：${String(body.messages[0]?.content).split("。")[0]}`);
        const response = await fetch(url, { ...init, body: JSON.stringify(body) });
        {
          const raw = await response.clone().text();
          let content = "";
          for (const line of raw.split("\n")) if (line.startsWith("data:")) {
            try { const event = JSON.parse(line.slice(5).trim()); content += event.choices?.[0]?.delta?.content ?? ""; } catch { /* DONE */ }
          }
          if (!content) { try { content = JSON.parse(raw).choices?.[0]?.message?.content ?? ""; } catch { /* transport errors are not retained */ } }
          diagnostics.push({ phase: String(body.messages[0]?.content).split("。")[0], input: JSON.parse(body.messages[1].content), content });
        }
        return response;
      } });
    id(await services.dispatch({ type: "profile.save", name: "连续写作隔离验证", purpose: "writing", model: profile.model, baseUrl: profile.baseUrl, apiKey: safeStorage.decryptString(Buffer.from(row.ciphertext as Uint8Array)) }));
    if (checkingRow) {
      const checking = JSON.parse(String(checkingRow.json));
      if (new URL(checking.baseUrl).hostname !== "api.deepseek.com") throw Error("检查配置不是官方DeepSeek接口");
      evidence.checkingModel = checking.model;
      id(await services.dispatch({ type: "profile.save", name: "连续写作检查隔离验证", purpose: "checking", model: checking.model, baseUrl: checking.baseUrl, apiKey: safeStorage.decryptString(Buffer.from(checkingRow.ciphertext as Uint8Array)) }));
    }
    const projectId = id(await services.dispatch({ type: "project.create", title: "小巷修表铺", genre: "温暖日常", background: "现代城市。青年阿宁跟随师傅周叔经营修表铺，以修好邻居的旧钟为五章主线；不涉及年龄谜团、复杂时间跳转或超自然能力。", chapterWords: 200 }));
    const jobId = id(await services.dispatch({ type: "conversation.send", projectId, text: "帮我把前五章都写完", tokenBudget: 100000 }));
    const deadline = Date.now() + 12 * 60 * 1000;
    while (services.snapshot().writingJobs!.find(j => j.id === jobId)!.status === "running") {
      if (Date.now() > deadline) { await services.dispatch({ type: "writing.pause", id: jobId }); throw Error("真实验证达到十二分钟时限"); }
      await new Promise(r => setTimeout(r, 500));
    }
    const job = services.snapshot().writingJobs!.find(j => j.id === jobId)!;
    evidence.result = { status: job.status, phase: job.phase, reply: job.reply, calls: job.calls, usage: job.usage, budgetUsed: job.budgetUsed,
      chapters: job.chapters.map(c => ({ ordinal: c.ordinal, status: c.status, revisionRounds: c.revisionRounds, words: c.chapterId ? services!.chapter(c.chapterId).content.replace(/\s/g, "").length : 0 })),
      issues: job.issues.map(i => ({ category: i.category, impact: i.impact, reason: i.reason })), warnings: job.warnings };
    evidence.passed = job.status === "completed" && job.chapters.length === 5;
    evidence.workflowCompleted = job.phase === "done" && job.chapters.length === 5 && job.chapters.every(c => ["checked", "needs-review"].includes(c.status));
    evidence.qualityPassed = job.status === "completed";
    if (!evidence.passed) process.exitCode = 1;
  } catch (e) {
    evidence.passed = false; evidence.error = e instanceof Error ? e.message.slice(0, 500) : "验证失败"; process.exitCode = 1;
  } finally {
    evidence.liveCalls = calls;
    if (services) await services.dispose();
    writeFileSync(resolve("docs/continuous-writing-live-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    writeFileSync(resolve(".tmp/continuous-writing-live-diagnostics.json"), JSON.stringify(diagnostics, null, 2) + "\n");
    rmSync(directory, { recursive: true, force: true }); app.quit();
  }
});
