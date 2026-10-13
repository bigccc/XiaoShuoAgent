// Run as an Electron main-process bundle. This uses only synthetic stories;
// production is opened read-only solely to obtain the existing protected profile.
import { app, safeStorage } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServices } from "../src/main/services";
import type { CommandResult } from "../src/shared/types";

const directory = mkdtempSync(join(tmpdir(), "novel-recovery-live-"));
app.setName("小说工坊");
app.setPath("userData", directory);
let services: AppServices | undefined;
let liveCalls = 0, injected = 0;
let injectFaults = false;
const evidence: Record<string, unknown> = { date: new Date().toISOString(), isolated: true, productionModified: false, outputCapPerLiveRequest: 3000 };
const sample = { message: "开篇已准备", chapters: [{ title: "雨夜", content: "雨点打在旧书店的玻璃上。林舟合上账本，听见门铃轻轻响了一声。", stage: "opening" }], memory: "雨夜的旧书店" };
const malformed = JSON.stringify({ message: sample.message, chapters: sample.chapters }) + ',"memory":"雨夜的旧书店"}';
function id(result: CommandResult) {
  if (!result.ok) throw Error(result.error.message);
  return result.entityId;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
void app.whenReady().then(async () => {
  try {
    const database = new DatabaseSync(join(homedir(), "Library/Application Support/小说工坊/works.sqlite"), { readOnly: true });
    const row = database.prepare("SELECT p.json,c.ciphertext FROM profiles p JOIN credentials c ON c.profile_id=p.id WHERE json_extract(p.json,'$.purpose')='writing'").get();
    database.close();
    check(row, "缺少已保存的写作配置");
    const profile = JSON.parse(String(row.json));
    check(new URL(profile.baseUrl).hostname === "api.deepseek.com", "此脚本仅用于本机官方DeepSeek配置");
    check(safeStorage.isEncryptionAvailable(), "系统密钥保护不可用");
    evidence.model = profile.model;
    services = new AppServices({
      dataDir: directory,
      credentials: { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(Buffer.from(value)) },
      dialogs: { open: async () => null, save: async () => null },
      provider: { timeoutMs: 90000 },
      fetch: async (url, init) => {
        if (injectFaults && injected < 2) {
          const content = injected++ === 0 ? "" : malformed;
          return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { headers: { "Content-Type": "application/json" } });
        }
        check(liveCalls < 4, "真实请求数量已到四次上限");
        liveCalls++;
        const body = JSON.parse(String(init?.body));
        body.max_tokens = Math.min(body.max_tokens, 3000);
        return fetch(url, { ...init, body: JSON.stringify(body) });
      },
    });
    id(await services.dispatch({ type: "profile.save", name: "隔离创作恢复验收", baseUrl: profile.baseUrl, model: profile.model, purpose: "writing", apiKey: safeStorage.decryptString(Buffer.from(row.ciphertext as Uint8Array)) }));
    async function run(title: string) {
      const projectId = id(await services!.dispatch({ type: "project.create", title }));
      const turnId = id(await services!.dispatch({ type: "conversation.send", projectId, text: "先试写一个雨夜旧书店的开篇，约300字；本轮只需message和chapters，不另建辅助资料。" }));
      const limit = Date.now() + 245000;
      while (services!.conversation(turnId).status === "running") {
        check(Date.now() < limit, "等待创作回复超时");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const turn = services!.conversation(turnId);
      return { projectId, turn, report: { status: turn.status, error: turn.error ?? null, calls: turn.attempts?.length, usage: turn.usage, attempts: turn.attempts?.map(({ rawResponse, ...a }) => ({ ...a, rawChars: rawResponse?.length ?? 0 })) } };
    }
    console.log("[live] 验证精简正文契约");
    const normal = await run("创作恢复·普通生成隔离样本");
    evidence.normalGeneration = normal.report;
    check(normal.turn.status === "completed" && normal.turn.chapterIds.length === 1, normal.turn.error ?? "普通生成未保存一章");
    injectFaults = true;
    console.log("[live] 注入空响应和尾部格式错误，验证真实模型修复");
    const recovered = await run("创作恢复·故障注入隔离样本");
    evidence.injectedRecovery = recovered.report;
    check(recovered.turn.status === "completed", recovered.turn.error ?? "自动恢复未完成");
    check(recovered.turn.attempts?.length === 3, "恢复请求数不是三次");
    check(services.chapter(recovered.turn.chapterIds[0]).content === sample.chapters[0].content && recovered.turn.memory === sample.memory, "修复改变了原始正文或丢失尾部共识");
    evidence.contentPreserved = true;
    evidence.passed = true;
    console.log("[live] 两个隔离样本完成");
  } catch (error) {
    evidence.passed = false;
    // Do not write arbitrary upstream errors or credentials into evidence.
    evidence.error = error instanceof Error ? error.message.slice(0, 500) : "验证失败";
    process.exitCode = 1;
    console.log("[live] 验证未完成，见不含正文和密钥的结果记录");
  } finally {
    evidence.liveCalls = liveCalls;
    evidence.injectedResponses = injected;
    if (services) await services.dispose();
    writeFileSync(resolve("docs/conversation-recovery-live-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    rmSync(directory, { recursive: true, force: true });
    app.quit();
  }
});
