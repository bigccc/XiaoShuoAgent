import { app, safeStorage } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServices } from "../src/main/services";
import type { CommandResult } from "../src/shared/types";

const directory = mkdtempSync(join(tmpdir(), "novel-revision-live-"));
app.setName("小说工坊");
app.setPath("userData", directory);
const evidence: Record<string, unknown> = {
  date: new Date().toISOString(),
  isolated: true,
  productionModified: false,
};
let services: AppServices | undefined;
function id(result: CommandResult) {
  if (!result.ok) throw Error(result.error.message);
  return result.entityId;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
void app.whenReady().then(async () => {
  console.log("[live] Electron 已就绪，读取隔离验证配置");
  try {
    const database = new DatabaseSync(
      join(homedir(), "Library/Application Support/小说工坊/works.sqlite"),
      { readOnly: true },
    );
    const row = database
      .prepare(
        "SELECT p.json,c.ciphertext FROM profiles p JOIN credentials c ON c.profile_id=p.id WHERE json_extract(p.json,'$.purpose')='writing'",
      )
      .get();
    database.close();
    check(row, "没有可用的已保护写作模型配置");
    const profile = JSON.parse(String(row.json));
    check(
      new URL(profile.baseUrl).hostname === "api.deepseek.com",
      "此验证脚本仅使用已配置的官方 DeepSeek 接口",
    );
    console.log("[live] 检查系统凭据保护");
    check(safeStorage.isEncryptionAvailable(), "系统密钥保护不可用");
    services = new AppServices({
      dataDir: directory,
      credentials: {
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value)),
      },
      dialogs: { open: async () => null, save: async () => null },
      provider: { timeoutMs: 60000 },
    });
    const secret = safeStorage.decryptString(
      Buffer.from(row.ciphertext as Uint8Array),
    );
    id(
      await services.dispatch({
        type: "profile.save",
        name: "隔离真实改稿验收",
        baseUrl: profile.baseUrl,
        model: profile.model,
        purpose: "writing",
        apiKey: secret,
      }),
    );
    console.log("[live] 验证精确选区修改");
    evidence.model = profile.model;
    const projectId = id(
      await services.dispatch({
        type: "project.create",
        title: "改稿隔离样本",
      }),
    );
    const first = id(
      await services.dispatch({
        type: "chapter.create",
        projectId,
        ordinal: 1,
        title: "雨夜",
      }),
    );
    const original =
      "林舟站在屋檐下。他觉得自己是个好人。雨还在下。他觉得自己是个好人。门口有人没有伞。";
    id(
      await services.dispatch({
        type: "chapter.save",
        id: first,
        revision: 1,
        content: original,
      }),
    );
    const quote = "他觉得自己是个好人。",
      start = original.lastIndexOf(quote),
      replacement = "他把伞递过去，自己走进雨里。";
    const selected = id(
      await services.dispatch({
        type: "revision.start",
        projectId,
        scope: "selection",
        selection: {
          chapterId: first,
          revision: services.chapter(first).revision,
          start,
          end: start + quote.length,
          quote,
        },
        text: `只把选段准确替换为“${replacement}”，其他内容不改。`,
        tokenBudget: 20000,
      }),
    );
    const wait = async (jobId: string) => {
      const timeout = Date.now() + 90000;
      while (
        services!.snapshot().revisionJobs!.find((j) => j.id === jobId)!
          .status === "running"
      ) {
        check(Date.now() < timeout, "真实模型改稿等待超时");
        await new Promise((r) => setTimeout(r, 250));
      }
      return services!.snapshot().revisionJobs!.find((j) => j.id === jobId)!;
    };
    const selectionJob = await wait(selected);
    check(
      selectionJob.status === "completed",
      selectionJob.error ?? selectionJob.reply,
    );
    check(
      services.chapter(first).content ===
        original.slice(0, start) +
          replacement +
          original.slice(start + quote.length),
      "选段之外的正文发生变化或指定替换未落实",
    );
    evidence.selection = {
      exactSecondQuote: true,
      untouchedOutsideSelection: true,
      status: selectionJob.status,
      calls: selectionJob.calls,
      usage: selectionJob.usage,
    };
    const second = id(
      await services.dispatch({
        type: "chapter.create",
        projectId,
        ordinal: 2,
        title: "第二天",
      }),
    );
    id(
      await services.dispatch({
        type: "chapter.save",
        id: second,
        revision: 1,
        content: "第二天，林舟在街边买了一把新伞。林舟想起昨晚那个人，笑了笑。",
      }),
    );
    const before = services
      .snapshot()
      .chapters.map((c) => ({ id: c.id, content: c.content }));
    const batchId = id(
      await services.dispatch({
        type: "revision.start",
        projectId,
        scope: "chapters",
        chapterIds: [first, second],
        text: "将人物姓名林舟统一改成林溪，只改姓名，所有其他文字保持原样；不新增设定或情节。",
        tokenBudget: 30000,
      }),
    );
    console.log("[live] 验证两章待审稿与采纳");
    const batch = await wait(batchId);
    check(
      batch.status === "awaiting-author" &&
        batch.candidates.length === 2 &&
        batch.checkedChapterIds.length === 2,
      batch.error ?? batch.reply,
    );
    check(
      before.every((c) => services!.chapter(c.id).content === c.content),
      "待审稿生成时覆盖了原文",
    );
    check(
      batch.candidates.every(
        (c) =>
          c.content ===
          before
            .find((b) => b.id === c.chapterId)!
            .content.replaceAll("林舟", "林溪"),
      ),
      "多章改稿改变了姓名之外的内容",
    );
    id(
      await services.dispatch({
        type: "revision.accept",
        id: batchId,
        includeMaterials: true,
      }),
    );
    check(
      before.every(
        (c) =>
          services!.chapter(c.id).content ===
          c.content.replaceAll("林舟", "林溪"),
      ),
      "采纳未保存全部待审稿",
    );
    evidence.result = "passed";
    evidence.selection = {
      exactSecondQuote: true,
      untouchedOutsideSelection: true,
      status: selectionJob.status,
      calls: selectionJob.calls,
      usage: selectionJob.usage,
    };
    evidence.batch = {
      generatedCandidates: batch.candidates.length,
      coverage: `${batch.checkedChapterIds.length}/${batch.chapterIds.length}`,
      originalRetainedUntilAdoption: true,
      adopted: true,
      calls: batch.calls,
      usage: batch.usage,
    };
  } catch (error) {
    evidence.result = "failed";
    evidence.error =
      error instanceof Error ? error.message : "真实改稿验证失败";
    process.exitCode = 1;
  } finally {
    await services?.dispose();
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(
      resolve("docs/long-form-live-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(JSON.stringify(evidence, null, 2));
    app.exit(process.exitCode ?? 0);
  }
});
