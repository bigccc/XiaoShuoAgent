import type {
  CandidateInput,
  DomainCommand,
  ErrorCode,
  JsonValue,
  SourceRevision,
} from "./types";
export class DomainError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function invalid(message = "输入格式不正确，请检查填写内容"): never {
  throw new DomainError("VALIDATION", message);
}
function object(x: unknown): asserts x is Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) invalid();
}
function text(x: unknown, required = false) {
  if (typeof x !== "string" || (required && !x.trim()))
    invalid(required ? "名称或必填内容不能为空" : undefined);
}
function revision(x: unknown) {
  if (!Number.isSafeInteger(x) || Number(x) < 1) invalid("版本编号不正确");
}
export function validateSources(x: unknown): asserts x is SourceRevision[] {
  if (!Array.isArray(x)) invalid();
  for (const s of x) {
    object(s);
    if (!["project", "note", "chapter"].includes(String(s.kind))) invalid();
    text(s.id, true);
    revision(s.revision);
  }
}
export function validatePublicJson(x: unknown): void {
  if (
    x === null ||
    typeof x === "string" ||
    typeof x === "boolean" ||
    (typeof x === "number" && Number.isFinite(x))
  )
    return;
  if (Array.isArray(x)) {
    x.forEach(validatePublicJson);
    return;
  }
  object(x);
  for (const [k, v] of Object.entries(x)) {
    if (
      /apikey|api_key|authorization|secret|password|credential|ciphertext/i.test(
        k,
      )
    )
      invalid("任务或内容快照不能包含密钥");
    validatePublicJson(v);
  }
}
export function validateCandidate(x: unknown): asserts x is CandidateInput {
  object(x);
  text(x.chapterId, true);
  text(x.content, true);
  text(x.taskId, true);
  validateSources(x.sourceRevisions);
  if (!(x.sourceRevisions as unknown[]).length)
    invalid("生成结果必须记录来源版本");
}
export function validateCommand(x: unknown): asserts x is DomainCommand {
  object(x);
  text(x.type, true);
  const c = x;
  const allowed: Record<string, string[]> = {
    "project.create": [
      "title",
      "background",
      "genre",
      "style",
      "pace",
      "targetWords",
      "chapterWords",
    ],
    "project.update": ["id", "revision", "patch"],
    "project.archive": ["id", "revision", "archived"],
    "note.save": [
      "id",
      "revision",
      "projectId",
      "noteType",
      "title",
      "body",
      "sources",
    ],
    "note.delete": ["id", "revision"],
    "chapter.create": ["projectId", "ordinal", "title", "style", "pace"],
    "chapter.save": ["id", "revision", "content", "title", "style", "pace"],
    "chapter.confirm": ["id", "revision"],
    "chapter.restore": ["id", "revision", "versionId"],
    "material.save": [
      "id",
      "revision",
      "materialType",
      "title",
      "source",
      "content",
      "explanation",
      "approved",
    ],
    "material.delete": ["id", "revision"],
    "material.link": ["id", "revision", "projectId", "linked"],
    "profile.save": [
      "id",
      "revision",
      "name",
      "baseUrl",
      "model",
      "purpose",
      "apiKey",
    ],
    "profile.delete": ["id", "revision"],
    "issue.resolve": ["id", "revision", "status"],
  };
  const fields = allowed[String(c.type)];
  if (!fields) invalid("不支持的操作");
  if (Object.keys(c).some((k) => k !== "type" && !fields.includes(k)))
    invalid("请求包含不支持的字段");
  if (c.id !== undefined) {
    text(c.id, true);
    revision(c.revision);
  } else if (
    ![
      "project.create",
      "chapter.create",
      "note.save",
      "material.save",
      "profile.save",
    ].includes(String(c.type))
  )
    invalid();
  if (c.revision !== undefined) {
    if (c.id === undefined) invalid("更新时必须提供目标编号");
    revision(c.revision);
  }
  for (const k of [
    "background",
    "genre",
    "style",
    "pace",
    "body",
    "content",
    "explanation",
    "apiKey",
  ])
    if (c[k] !== undefined) text(c[k]);
  for (const k of [
    "title",
    "name",
    "model",
    "source",
    "projectId",
    "versionId",
  ])
    if (c[k] !== undefined) text(c[k], true);
  for (const k of ["archived", "approved", "linked"])
    if (c[k] !== undefined && typeof c[k] !== "boolean") invalid();
  switch (c.type) {
    case "project.create":
      text(c.title, true);
      break;
    case "project.update":
      object(c.patch);
      if (!Object.keys(c.patch).length) invalid();
      if (
        Object.keys(c.patch).some(
          (k) => !allowed["project.create"]!.includes(k),
        )
      )
        invalid();
      for (const [k, v] of Object.entries(c.patch)) {
        if (k.endsWith("Words")) {
          if (!Number.isSafeInteger(v) || Number(v) < 1)
            invalid("字数目标必须为正整数");
        } else text(v, k === "title");
      }
      break;
    case "note.save":
      text(c.projectId, true);
      text(c.title, true);
      text(c.body);
      if (
        ![
          "character",
          "world",
          "location",
          "storyline",
          "outline",
          "chapterOutline",
          "summary",
          "timeline",
          "knowledge",
          "foreshadowing",
        ].includes(String(c.noteType))
      )
        invalid();
      validateSources(c.sources);
      break;
    case "chapter.create":
      text(c.projectId, true);
      text(c.title, true);
      revision(c.ordinal);
      break;
    case "chapter.save":
      text(c.content);
      break;
    case "chapter.restore":
      text(c.versionId, true);
      break;
    case "material.save":
      text(c.title, true);
      text(c.source, true);
      text(c.content, true);
      text(c.explanation);
      if (
        !["expression", "plot"].includes(String(c.materialType)) ||
        typeof c.approved !== "boolean"
      )
        invalid();
      break;
    case "material.link":
      text(c.projectId, true);
      break;
    case "profile.save":
      text(c.name, true);
      text(c.model, true);
      text(c.baseUrl, true);
      try {
        const u = new URL(String(c.baseUrl));
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          invalid("API地址应为不含凭据的 HTTP 或 HTTPS 地址");
      } catch {
        invalid("API地址格式不正确");
      }
      if (!["planning", "writing", "checking"].includes(String(c.purpose)))
        invalid();
      break;
    case "issue.resolve":
      if (!["resolved", "ignored"].includes(String(c.status))) invalid();
      break;
  }
  for (const k of ["targetWords", "chapterWords"])
    if (c[k] !== undefined && (!Number.isSafeInteger(c[k]) || Number(c[k]) < 1))
      invalid("字数目标必须为正整数");
}
function validateMeta(x: Record<string, unknown>): void {
  text(x.id, true);
  revision(x.revision);
  for (const k of ["createdAt", "updatedAt"]) {
    text(x[k], true);
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(String(x[k])) ||
      !Number.isFinite(Date.parse(String(x[k])))
    )
      invalid("时间格式必须为 ISO 时间");
  }
}
export function validateTask(x: unknown): void {
  object(x);
  validateMeta(x);
  text(x.projectId, true);
  text(x.partial);
  validateSources(x.sourceRevisions);
  validatePublicJson(x);
  if (
    !["generation", "planning", "check", "extraction", "connection"].includes(
      String(x.kind),
    ) ||
    ![
      "waiting",
      "running",
      "awaiting-author",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(String(x.status)) ||
    !Number.isSafeInteger(x.calls) ||
    Number(x.calls) < 0
  )
    invalid("任务数据格式不正确");
  if (x.requestSnapshot === undefined || x.result === undefined)
    invalid("任务必须包含请求快照和结果字段");
  if (x.usage !== null) {
    object(x.usage);
    if (typeof x.usage.estimated !== "boolean") invalid();
    for (const k of ["inputTokens", "outputTokens", "totalTokens"])
      if (
        x.usage[k] !== null &&
        (!Number.isSafeInteger(x.usage[k]) || Number(x.usage[k]) < 0)
      )
        invalid("用量数据格式不正确");
  }
  if (x.error !== undefined) text(x.error);
}
export function validateIssue(x: unknown): void {
  object(x);
  validateMeta(x);
  text(x.projectId, true);
  text(x.reason, true);
  validatePublicJson(x);
  if (
    ![
      "character",
      "timeline",
      "location",
      "world",
      "knowledge",
      "foreshadowing",
    ].includes(String(x.type)) ||
    !["open", "resolved", "ignored"].includes(String(x.status))
  )
    invalid("检查问题格式不正确");
  if (!Array.isArray(x.evidence) || !x.evidence.length)
    invalid("检查问题必须包含原文依据");
  for (const evidence of x.evidence) {
    object(evidence);
    text(evidence.quote, true);
    validateSources([evidence.source]);
  }
}
