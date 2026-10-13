import type { ConversationAttempt, ConversationResponse, ConversationTurn, TaskUsage } from "../shared/types";
import { parseConversationResponse } from "../shared/conversation";
import { DomainError } from "../shared/validation";
import { ChatProvider, ProviderError, type ChatRequest } from "./provider";

// Known usage is a lower bound when any attempt did not report it. Never
// turn a failed/unknown request into zero reported consumption.
export function conversationUsage(attempts: ConversationAttempt[]): TaskUsage | null {
  if (!attempts.length) return null;
  const sum = (key: "inputTokens" | "outputTokens" | "totalTokens") => {
    const known = attempts.flatMap(a => a.usage?.[key] == null ? [] : [a.usage[key]!]);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return {
    inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"),
    estimated: attempts.some(a => !a.usage || a.usage.estimated || [a.usage.inputTokens, a.usage.outputTokens, a.usage.totalTokens].includes(null)),
  };
}

// Accept punctuation/key repairs only if all original string values survive.
// Lex the whole payload (including text beyond an early closing brace), never
// extract its first JSON object. Unrecognizable text is deliberately rejected.
function stringValues(text: string): Map<string, number> {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const values = new Map<string, number>();
  const token = /\s+|"(?:[^"\\]|\\.)*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gy;
  let index = 0;
  let previous = "", property = "";
  while (index < source.length) {
    token.lastIndex = index;
    const match = token.exec(source);
    if (!match) throw new DomainError("VALIDATION", "无法确认格式修复保留了全部内容，原始回复已保留");
    index = token.lastIndex;
    if (match[0].trim() === "") continue;
    if (match[0].startsWith('"')) {
      let value: string;
      try { value = JSON.parse(match[0]); }
      catch { throw new DomainError("VALIDATION", "无法确认格式修复保留了全部内容，原始回复已保留"); }
      if (source.slice(index).trimStart().startsWith(":")) property = value;
      else {
        const identity = JSON.stringify([previous === ":" ? property : "[]", value]);
        values.set(identity, (values.get(identity) ?? 0) + 1);
      }
    }
    previous = match[0];
  }
  return values;
}
function contentRecords(text: string): Record<string, unknown>[] {
  // Complete nested records remain recoverable even if the surrounding root
  // closes too early. Removing only punctuation outside strings also covers
  // trailing commas, without changing any literal text.
  const source = text.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (all, quoted, closing) => quoted ?? closing);
  const tokens = /"(?:[^"\\]|\\.)*"|[{}]/g;
  const starts: number[] = [], records: Record<string, unknown>[] = [];
  for (const match of source.matchAll(tokens)) {
    if (match[0] === "{") starts.push(match.index!);
    else if (match[0] === "}" && starts.length) {
      const start = starts.pop()!;
      try {
        const record = JSON.parse(source.slice(start, match.index! + 1));
        if (["content", "body", "text"].some(key => typeof record[key] === "string")) records.push(record);
      } catch { /* The outer malformed object is not a protected record. */ }
    }
    if (starts.length > 64) throw new DomainError("VALIDATION", "回复结构过深，原始回复已保留");
  }
  return records;
}
function preserveText(original: string, repaired: ConversationResponse) {
  const output = JSON.stringify(repaired);
  const before = stringValues(original), after = stringValues(output);
  const fail = () => { throw new DomainError("VALIDATION", "格式修复改变了已生成的内容或归属，原始回复已保留；正文未被修改"); };
  if (before.size !== after.size) fail();
  for (const [value, count] of before)
    if (after.get(value) !== count) fail();
  const records = contentRecords(original), candidates = contentRecords(output);
  // A new/unrecognized content record has no provable original association.
  if (records.length !== candidates.length) fail();
  // New chapters receive ordinals in response order. An unordered comparison
  // would let a syntax repair silently change the story's chronology.
  records.forEach((record, index) => {
    if (!Object.entries(record).every(([key, value]) => JSON.stringify(candidates[index][key]) === JSON.stringify(value))) fail();
  });
}

async function pause(signal: AbortSignal) {
  if (signal.aborted) throw new ProviderError("CANCELLED", "任务已取消");
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new ProviderError("CANCELLED", "任务已取消")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function completeConversation(
  provider: ChatProvider,
  request: ChatRequest,
  report: (patch: Pick<ConversationTurn, "attempts" | "usage" | "recoveryPhase">) => void,
): Promise<ConversationResponse> {
  const attempts: ConversationAttempt[] = [];
  const deadline = AbortSignal.timeout(240_000);
  const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
  let emptyRetried = false, repairSource: string | undefined;
  let phase: ConversationTurn["recoveryPhase"] = "requesting";
  const publish = () => report({ attempts: structuredClone(attempts), usage: conversationUsage(attempts), recoveryPhase: phase });
  try {
    for (let number = 0; number < 3; number++) {
      if (signal.aborted) throw new ProviderError("CANCELLED", "任务已取消");
      phase = repairSource === undefined ? phase : "repairing";
      const attempt: ConversationAttempt = { phase: repairSource === undefined ? "generate" : "repair", status: "running", startedAt: new Date().toISOString(), usage: null };
      attempts.push(attempt);
      publish();
      let raw: string;
      try {
        const result = await provider.complete({
          ...request, maxAttempts: 1, signal,
          messages: repairSource === undefined ? request.messages : [
            ...request.messages,
            { role: "assistant", content: repairSource },
            { role: "user", content: "上次回复未通过JSON结构校验。只修正格式，返回且仅返回一个完整JSON对象。原始回复的所有文本值（正文、标题、设定、共识、id等）必须逐字保留，不能删减、重写、只取第一个对象或清空chapters/notes；末尾附加的字段也须完整归入对象。修正括号、逗号、字段名或补齐必要结构，仍遵守本轮阶段和授权id。若无法在不改变内容的前提下修正，请明确说明，应用会保留原始回复。" },
          ],
        });
        raw = result.text;
        attempt.rawResponse = raw;
        attempt.usage = result.usage;
        if (result.diagnostics) attempt.diagnostics = result.diagnostics;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (deadline.aborted && !request.signal?.aborted) {
          error.code = "TIMEOUT";
          error.message = "本轮自动恢复已达到四分钟时限，已有回复已保留";
          error.transient = false;
        }
        attempt.status = "failed";
        attempt.code = error.code;
        attempt.error = error.message;
        attempt.usage = error.usage ?? null;
        if (error.diagnostics) attempt.diagnostics = error.diagnostics;
        if (error.partial) attempt.rawResponse = error.partial;
        attempt.finishedAt = new Date().toISOString();
        const retryEmpty = error.code === "EMPTY" && !emptyRetried;
        const retryNetwork = error.transient && !error.partial;
        const retry = repairSource === undefined && !signal.aborted && number < 2 && (retryEmpty || retryNetwork);
        if (retryEmpty) emptyRetried = true;
        if (retry) phase = repairSource === undefined ? "retrying" : "repairing";
        publish();
        if (!retry) throw error;
        await pause(signal);
        continue;
      }
      attempt.finishedAt = new Date().toISOString();
      try {
        const response = parseConversationResponse(raw);
        if (repairSource !== undefined) preserveText(repairSource, response);
        if (signal.aborted) throw new ProviderError("CANCELLED", "任务已取消");
        attempt.status = "completed";
        publish();
        return response;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        attempt.status = "failed";
        attempt.code = "RESPONSE_FORMAT";
        attempt.error = error.message;
        const canRepair = repairSource === undefined && raw.length <= 100000 && number < 2 && !signal.aborted;
        if (canRepair) { repairSource = raw; phase = "repairing"; }
        publish();
        if (!canRepair) throw error;
      }
    }
    throw new ProviderError("FORMAT", "本轮自动恢复次数已用完，原始回复已保留");
  } catch (error) {
    if (deadline.aborted && !request.signal?.aborted)
      throw new ProviderError("TIMEOUT", "本轮自动恢复已达到四分钟时限，已有回复已保留");
    throw error;
  }
}
