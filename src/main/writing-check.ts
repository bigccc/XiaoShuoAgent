import type { WritingIssue } from "../shared/writing";
import type { SourceRevision } from "../shared/types";
import type { ContextDocument } from "./context";
import { ProviderError } from "./provider";
import { canonicalQuote } from "./quality";
import { unwrapWritingJson } from "./writing-json";

export const writingReviewInstruction =
  '只返回完整 JSON：{"issues":[{"category":"character|timeline|plot|world|knowledge|foreshadowing|style|pacing|length","impact":"blocking|local","reason":"明确问题、影响及证据如何支持判断","evidence":[{"quote":"连续逐字原文","source":{"kind":"project|note|chapter","id":"来源ID","revision":1}}]}],"majorChange":false,"reason":"需要作者决定的重大创作变更原因，否则空字符串"}。' +
  "不得增加字段，不填写chapterId，JSON前后不得追加说明。按影响只报告最重要的最多3项；每项reason尽量在150字内，每项evidence取2至4条最短充分原文，每段quote尽量在120字内，避免重复引用整段正文导致输出截断。" +
  "source必须复制本次原文方括号内的kind、id及@后的实际revision，示例中的1不是默认版本。quote须连续逐字复制，不能改写事实、改标点、用省略号拼接，不能引用未提供或其他作品的内容。" +
  "事实冲突与文风建议分开：character、timeline、plot、world、knowledge、foreshadowing只用于原文明示且不能同时成立的事实冲突，impact必须为blocking。每项必须引用矛盾双方至少两条不同原文依据，说明同一对象、同一时间和同一事实口径；找不到双方证据时不列入issues。" +
  "style、pacing、length为局部待审建议，impact必须为local，至少引用一条直接相关原文。不能把人设、时间线、主线等事实冲突改称style或pacing来降低影响。篇幅以提供的实际字数和目标为准，不能仅凭感觉判断不足。" +
  "只检查本次指定章节；需要调整的章节依据放在本项evidence最后，应用由最后一条chapter来源定位章节，关联设定和前章证据放在它前面。" +
  "正常时间推进、人物移动、物品取放、已解释的状态变化不算冲突；多个故障可以同时存在，修好一处后发现另一处故障不是根因冲突；不同零件默认是不同对象，不能仅因故事先后提到两种零件就认定同一物体改名。区分回忆、角色猜测、说谎与叙述事实，不能凭空假设动作来消除明确矛盾，也不能把缺少后续描写当作已经发生的矛盾。" +
  "无确定问题返回issues=[]，不得为凑类别制造问题。只有必须推翻已确认人设、主线或结局才能继续时majorChange=true，并在顶层reason明确要改变的已确认内容及原因，等待作者决定；普通细节补充、文风建议和一般疑点不能设为重大变更，无理由不得majorChange=true。";

const factualCategories = new Set<WritingIssue["category"]>([
  "character", "timeline", "plot", "world", "knowledge", "foreshadowing",
]);
const localCategories = new Set<WritingIssue["category"]>(["style", "pacing", "length"]);

function formatError(message: string): never {
  throw new ProviderError("FORMAT", `连续写作检查${message}`);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    formatError("格式不正确，必须返回完整对象");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key)))
    formatError("包含未知字段或缺少必需字段");
  return result;
}

function boundedText(value: unknown, maximum: number, required = true): string {
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim()))
    formatError("文字内容为空、过长或格式不正确");
  return value;
}

function parseEvidence(value: unknown, documents: ContextDocument[]): WritingIssue["evidence"][number] {
  const item = record(value, ["quote", "source"]);
  const quote = boundedText(item.quote, 8000);
  const source = record(item.source, ["kind", "id", "revision"]);
  const id = boundedText(source.id, 200);
  if (!["project", "note", "chapter"].includes(String(source.kind)) ||
      !Number.isSafeInteger(source.revision) || Number(source.revision) < 1)
    formatError("依据来源类型或版本不正确");

  for (const document of documents) {
    if (document.source.kind !== source.kind || document.source.id !== id || document.source.revision !== source.revision)
      continue;
    const original = canonicalQuote(document.text, quote);
    if (original !== undefined) {
      boundedText(original, 8000);
      return { quote: original, source: { ...document.source } as SourceRevision };
    }
  }
  return formatError("依据无法对应本次输入原文及来源版本");
}

export function parseWritingReview(
  raw: string,
  documents: ContextDocument[],
): { issues: WritingIssue[]; majorChange: boolean; reason: string } {
  if (typeof raw !== "string" || raw.length > 262144)
    formatError("输出过长或格式不正确");
  const text = unwrapWritingJson(raw);
  // Only unwrap a complete fence. Extracting the first object could discard a
  // trailing majorChange or another finding and incorrectly approve the task.
  const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    formatError("不是有效的完整 JSON，不能作为检查通过");
  }
  const result = record(parsed, ["issues", "majorChange", "reason"]);
  if (!Array.isArray(result.issues) || result.issues.length > 20 || typeof result.majorChange !== "boolean")
    formatError("问题列表或重大变更标记不正确");
  const reason = boundedText(result.reason, 2000, result.majorChange).trim();
  const issues: WritingIssue[] = result.issues.map(value => {
    const issue = record(value, ["category", "impact", "reason", "evidence"]);
    const category = issue.category as WritingIssue["category"];
    if (!factualCategories.has(category) && !localCategories.has(category))
      formatError("问题类别不正确");
    const impact = factualCategories.has(category) ? "blocking" : "local";
    if (issue.impact !== impact)
      formatError("事实冲突必须为blocking，局部建议必须为local");
    const issueReason = boundedText(issue.reason, 2000).trim();
    if (!Array.isArray(issue.evidence) || issue.evidence.length < (impact === "blocking" ? 2 : 1) || issue.evidence.length > 10)
      formatError("缺少问题原文依据；事实冲突必须提供双方证据");
    const evidence = issue.evidence.map(item => parseEvidence(item, documents));
    const unique = new Set(evidence.map(item => JSON.stringify([item.source.kind, item.source.id, item.source.revision, item.quote])));
    if (unique.size !== evidence.length)
      formatError("存在重复证据，不能以同一处原文代替矛盾双方");
    const chapterId = evidence.filter(item => item.source.kind === "chapter").at(-1)?.source.id;
    return { category, impact, reason: issueReason, evidence, ...(chapterId ? { chapterId } : {}) };
  });
  return { issues, majorChange: result.majorChange, reason };
}
