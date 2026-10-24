import { app, safeStorage } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServices } from "../src/main/services";
import { paragraphDiff } from "../src/shared/revision";
import { assertOfficialDeepSeekHttps } from "./live-profile-guard";
import type { CommandResult } from "../src/shared/types";
import type { WritingJob } from "../src/shared/writing";

const directory = mkdtempSync(join(tmpdir(), "novel-writing-review-live-"));
const startedAt = Date.now();
const deadline = startedAt + 12 * 60 * 1000;
const requestLimit = 12;
const outputCap = 4000;
app.setName("小说工坊");
app.setPath("userData", directory);
let services: AppServices | undefined;
let calls = 0;
const diagnostics: { phase: string; input: any; content: string }[] = [];
const evidence: Record<string, any> = {
  date: new Date().toISOString(),
  isolated: true,
  productionModified: false,
  requestLimit,
  outputCap,
  timeLimitMs: 12 * 60 * 1000,
  scenarios: [],
  literaryQualityPassed: null,
  humanReview: {
    status: "pending",
    targetConflictResolved: null,
    newConflicts: null,
    unnecessaryEdits: null,
    voiceRegressed: null,
  },
};
function id(result: CommandResult) {
  if (!result.ok) throw Error(result.error.message);
  return result.entityId;
}
function service() {
  if (!services) throw Error("验证服务尚未初始化");
  return services;
}
function issueView(job: WritingJob) {
  return job.issues.map(issue => ({
    category: issue.category,
    impact: issue.impact,
    reason: issue.reason,
    quotes: issue.evidence.map(item => item.quote),
  }));
}
async function waitWriting(jobId: string) {
  const current = service();
  while (current.snapshot().writingJobs?.find(job => job.id === jobId)?.status === "running") {
    if (Date.now() > deadline) {
      await current.dispatch({ type: "writing.pause", id: jobId });
      throw Error("真实验证达到十二分钟时限");
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const job = current.snapshot().writingJobs?.find(item => item.id === jobId);
  if (!job) throw Error("写作任务不存在");
  return job;
}
function metrics(job: WritingJob, diagnosticStart: number, scenarioStart: number) {
  const summary = service().billingSummary(job.id);
  return {
    elapsedMs: Date.now() - scenarioStart,
    calls: job.calls,
    recordedRequests: diagnostics.length - diagnosticStart,
    usage: job.usage,
    budgetUsed: job.budgetUsed,
    estimatedCost: {
      spentMicros: summary.unknown ? null : summary.spentMicros,
      unknown: summary.unknown,
      source: "按已配置价格估算，非服务商账单",
    },
  };
}
async function startReview(title: string, content: string) {
  const current = service();
  const projectId = id(await current.dispatch({
    type: "project.create",
    title,
    genre: "温暖日常",
    background: "现代城市。林舟经营一家修表铺；没有年龄谜团、时间循环或超自然能力。",
    chapterWords: 100,
  }));
  const chapterId = id(await current.dispatch({ type: "chapter.create", projectId, ordinal: 1, title: "雨夜" }));
  id(await current.dispatch({ type: "chapter.save", id: chapterId, revision: 1, content }));
  const jobId = id(await current.dispatch({
    type: "writing.start",
    projectId,
    text: "检查并修正第1章，保留作者创作方向与篇幅，明确错误先给出修改预览。",
    reviewOnly: true,
    goal: { kind: "append", startOrdinal: 1, endOrdinal: 1 },
    tokenBudget: 100000,
  }));
  return { projectId, chapterId, jobId, initial: await waitWriting(jobId) };
}
async function conflictScenario() {
  const scenarioStart = Date.now();
  const diagnosticStart = diagnostics.length;
  const original = "林舟今年十八岁。去年，林舟已经三十岁。雨落在修表铺外。";
  const { chapterId, jobId, initial } = await startReview("隔离验收·事实冲突", original);
  const current = service();
  const baseChapter = current.chapter(chapterId);
  const result: Record<string, any> = {
    name: "existing-conflict",
    jobId,
    initialStatus: initial.status,
    initialIssues: issueView(initial),
    original,
    authorActionsAfterInitialCheck: 0,
    ...metrics(initial, diagnosticStart, scenarioStart),
  };
  if (initial.status !== "awaiting-author" || !initial.issues.some(issue => issue.impact === "blocking")) {
    result.workflowPassed = false;
    result.error = "明确冲突没有进入作者处理状态";
    return result;
  }
  id(await current.dispatch({
    type: "writing.resume",
    id: jobId,
    repair: true,
    text: "保持今年十八岁，只修正已证实的时间冲突，生成修改预览，不直接覆盖原稿。",
  }));
  result.authorActionsAfterInitialCheck++;
  const proposed = await waitWriting(jobId);
  result.proposedStatus = proposed.status;
  result.proposedIssues = issueView(proposed);
  result.originalProtectedBeforeAccept = current.chapter(chapterId).content === original && current.chapter(chapterId).revision === baseChapter.revision;
  if (!proposed.revisionJobIds.length) {
    result.workflowPassed = false;
    result.error = "明确授权后没有生成修改候选";
    return result;
  }
  const revision = current.revisionJob(proposed.revisionJobIds[0]);
  const candidate = revision.candidates.find(item => item.chapterId === chapterId && item.status === "pending");
  if (!candidate) {
    result.workflowPassed = false;
    result.error = "修改候选不存在或已失效";
    return result;
  }
  const baseCharacters = candidate.baseContent.replace(/\s/g, "").length;
  const candidateCharacters = candidate.content.replace(/\s/g, "").length;
  result.candidate = {
    baseContent: candidate.baseContent,
    content: candidate.content,
    sourceRevision: candidate.sourceRevision,
    baseCharacters,
    characters: candidateCharacters,
    characterDelta: candidateCharacters - baseCharacters,
    diff: paragraphDiff(candidate.baseContent, candidate.content),
  };
  result.revisionCalls = diagnostics.slice(diagnosticStart).filter(item => item.phase === "连续写作·定点修正").length;
  const acceptDiagnosticStart = diagnostics.length;
  id(await current.dispatch({ type: "revision.accept", id: revision.id, chapterIds: [chapterId] }));
  result.authorActionsAfterInitialCheck++;
  id(await current.dispatch({ type: "writing.resume", id: jobId }));
  const final = await waitWriting(jobId);
  const finalChapter = current.chapter(chapterId);
  const checksAfterAccept = diagnostics.slice(acceptDiagnosticStart).filter(item => item.phase === "连续写作·检查" && typeof item.input?.context === "string" && item.input.context.includes(candidate.content));
  Object.assign(result, metrics(final, diagnosticStart, scenarioStart), {
    finalStatus: final.status,
    finalIssues: issueView(final),
    finalReviewNotes: final.reviewNotes ?? [],
    finalWarnings: final.warnings,
    finalReply: final.reply,
    finalContent: finalChapter.content,
    checkedRevision: final.chapters[0].checkedRevision,
    currentRevision: finalChapter.revision,
    checksAfterAccept: checksAfterAccept.length,
  });
  result.workflowPassed = result.originalProtectedBeforeAccept && result.revisionCalls === 1 && final.status === "completed" &&
    !final.issues.some(issue => issue.impact === "blocking") && finalChapter.content === candidate.content &&
    final.chapters[0].checkedRevision === finalChapter.revision && checksAfterAccept.length > 0;
  return result;
}
async function cleanScenario() {
  const scenarioStart = Date.now();
  const diagnosticStart = diagnostics.length;
  const original = "林舟今年十八岁。去年，林舟十七岁。雨落在修表铺外。";
  const { chapterId, jobId, initial } = await startReview("隔离验收·正常对照", original);
  const finalChapter = service().chapter(chapterId);
  const revisionCalls = diagnostics.slice(diagnosticStart).filter(item => item.phase === "连续写作·定点修正").length;
  return {
    name: "existing-clean-control",
    jobId,
    initialStatus: initial.status,
    finalStatus: initial.status,
    initialIssues: issueView(initial),
    finalIssues: issueView(initial),
    original,
    finalContent: finalChapter.content,
    authorActionsAfterInitialCheck: 0,
    revisionJobIds: initial.revisionJobIds,
    revisionCalls,
    ...metrics(initial, diagnosticStart, scenarioStart),
    workflowPassed: initial.status === "completed" && !initial.issues.some(issue => issue.impact === "blocking") &&
      initial.revisionJobIds.length === 0 && revisionCalls === 0 && finalChapter.content === original,
  };
}
void app.whenReady().then(async () => {
  try {
    const db = new DatabaseSync(join(homedir(), "Library/Application Support/小说工坊/works.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT p.json,c.ciphertext FROM profiles p JOIN credentials c ON c.profile_id=p.id WHERE json_extract(p.json,'$.purpose')='writing'").get();
    const checkingRow = db.prepare("SELECT p.json,c.ciphertext FROM profiles p JOIN credentials c ON c.profile_id=p.id WHERE json_extract(p.json,'$.purpose')='checking'").get();
    db.close();
    if (!row) throw Error("缺少已保存的写作模型");
    const profile = JSON.parse(String(row.json));
    assertOfficialDeepSeekHttps(profile.baseUrl);
    if (!safeStorage.isEncryptionAvailable()) throw Error("系统密钥保护不可用");
    evidence.model = profile.model;
    services = new AppServices({
      dataDir: directory,
      credentials: {
        encrypt: value => safeStorage.encryptString(value),
        decrypt: value => safeStorage.decryptString(Buffer.from(value)),
      },
      dialogs: { open: async () => null, save: async () => null },
      provider: { timeoutMs: 90000 },
      fetch: async (url, init) => {
        assertOfficialDeepSeekHttps(String(url));
        if (calls >= requestLimit) throw Error("真实请求已达到本次验证上限");
        calls++;
        const body = JSON.parse(String(init?.body));
        body.max_tokens = Math.min(body.max_tokens, outputCap);
        console.log(`[live] 请求 ${calls}：${String(body.messages[0]?.content).split("。")[0]}`);
        const response = await fetch(url, { ...init, body: JSON.stringify(body) });
        const raw = await response.clone().text();
        let content = "";
        for (const line of raw.split("\n")) if (line.startsWith("data:")) {
          try {
            const event = JSON.parse(line.slice(5).trim());
            content += event.choices?.[0]?.delta?.content ?? "";
          } catch { }
        }
        if (!content) {
          try { content = JSON.parse(raw).choices?.[0]?.message?.content ?? ""; } catch { }
        }
        diagnostics.push({
          phase: String(body.messages[0]?.content).split("。")[0],
          input: JSON.parse(body.messages[1].content),
          content,
        });
        return response;
      },
    });
    id(await services.dispatch({
      type: "profile.save",
      name: "已有正文检查隔离验证",
      purpose: "writing",
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKey: safeStorage.decryptString(Buffer.from(row.ciphertext as Uint8Array)),
      ...(profile.pricing ? { pricing: profile.pricing } : {}),
    }));
    if (checkingRow) {
      const checking = JSON.parse(String(checkingRow.json));
      assertOfficialDeepSeekHttps(checking.baseUrl);
      evidence.checkingModel = checking.model;
      id(await services.dispatch({
        type: "profile.save",
        name: "已有正文复核隔离验证",
        purpose: "checking",
        model: checking.model,
        baseUrl: checking.baseUrl,
        apiKey: safeStorage.decryptString(Buffer.from(checkingRow.ciphertext as Uint8Array)),
        ...(checking.pricing ? { pricing: checking.pricing } : {}),
      }));
    }
    for (const [name, scenario] of [["existing-conflict", conflictScenario], ["existing-clean-control", cleanScenario]] as const) {
      try {
        evidence.scenarios.push(await scenario());
      } catch (error) {
        evidence.scenarios.push({ name, workflowPassed: false, error: error instanceof Error ? error.message.slice(0, 500) : "验证失败" });
      }
    }
    evidence.workflowPassed = evidence.scenarios.length === 2 && evidence.scenarios.every((scenario: any) => scenario.workflowPassed);
    if (!evidence.workflowPassed) process.exitCode = 1;
  } catch (error) {
    evidence.workflowPassed = false;
    evidence.error = error instanceof Error ? error.message.slice(0, 500) : "验证失败";
    process.exitCode = 1;
  } finally {
    evidence.liveCalls = calls;
    evidence.elapsedMs = Date.now() - startedAt;
    if (services) await services.dispose();
    mkdirSync(resolve(".tmp"), { recursive: true });
    const stamp = String(evidence.date).replaceAll(":", "-").replaceAll(".", "-");
    writeFileSync(resolve(".tmp/writing-review-live-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    writeFileSync(resolve(".tmp/writing-review-live-diagnostics.json"), JSON.stringify(diagnostics, null, 2) + "\n");
    writeFileSync(resolve(`.tmp/writing-review-live-${stamp}-evidence.json`), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    writeFileSync(resolve(`.tmp/writing-review-live-${stamp}-diagnostics.json`), JSON.stringify(diagnostics, null, 2) + "\n", { flag: "wx" });
    rmSync(directory, { recursive: true, force: true });
    app.quit();
  }
});
