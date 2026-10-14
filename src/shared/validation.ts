import {validateVoiceStamp} from "./voice";
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
          "supplement",
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
  try {
    validateTaskPayload(x);
  } catch (error) {
    if (error instanceof DomainError)
      invalid(`任务数据格式不正确：${error.message}`);
    throw error;
  }
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

// These are persisted producer contracts, not a generic JSON envelope. They are
// shared with the task reviewer so damaged local records fail visibly as well.
function taskObject(value: unknown): Record<string, any> {
  object(value);
  return value;
}
function taskArray(value: unknown, max = 1000): any[] {
  if (!Array.isArray(value) || value.length > max)
    invalid("任务列表格式不正确");
  return value;
}
function taskStrings(value: unknown, max = 1000): string[] {
  const items = taskArray(value, max);
  items.forEach((item) => text(item, true));
  return items;
}
function taskBoolean(value: unknown): void {
  if (typeof value !== "boolean") invalid("任务状态字段格式不正确");
}
function taskFields(value: Record<string, any>, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    invalid("任务包含不支持的字段");
}
const noteTypes = [
  "idea",
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
          "supplement",
];
function matchingSource(source: any, sources: SourceRevision[]): boolean {
  return sources.some(
    (s) =>
      s.kind === source.kind &&
      s.id === source.id &&
      s.revision === source.revision,
  );
}
function validateTaskPayload(task: Record<string, any>): void {
  const request = taskObject(task.requestSnapshot);
  taskFields(request, [
    "command",
    "profile",
    "checkingProfile",
    "context",
    "inputText",
  ]);
  const command = taskObject(request.command);
  const kindCommands: Record<string, string> = {
    generation: "ai.chapter",
    planning: "ai.plan",
    check: "ai.check",
    extraction: "ai.extract",
    connection: "model.test",
  };
  if (command.type !== kindCommands[task.kind]) invalid("任务类型与请求不一致");
  const common = [
    "type",
    "projectId",
    "profileId",
    "tokenBudget",
    "instruction",
    "includeDraftIds",
    "noteIds",
    "materialIds",
    "allowAutoMaterials",
  ];
  taskFields(
    command,
    command.type === "model.test"
      ? ["type", "projectId", "profileId"]
      : [
          ...common,
          ...(command.type === "ai.chapter"
            ? [
                "chapterIds",
                "authorizeBatch",
                "checkingProfileId",
                "chapterWords",
              ]
            : command.type === "ai.check"
              ? ["chapterIds"]
              : command.type === "ai.plan"
                ? ["step", "planningMaxWords", "maxOutputTokens"]
                : ["source", "sourceText"]),
        ],
  );
  text(command.profileId, true);
  if (command.type === "model.test") {
    if (command.projectId !== undefined) text(command.projectId, true);
    if ((command.projectId ?? "@connection") !== task.projectId)
      invalid("任务作品归属不一致");
  } else {
    text(command.projectId, true);
    if (command.projectId !== task.projectId) invalid("任务作品归属不一致");
    if (
      !Number.isSafeInteger(command.tokenBudget) ||
      command.tokenBudget < 100 ||
      command.tokenBudget > 10000000
    )
      invalid("任务预算格式不正确");
    if (command.instruction !== undefined) {
      text(command.instruction);
      if (command.instruction.length > 10000) invalid("任务要求超过长度限制");
    }
    for (const field of ["includeDraftIds", "noteIds", "materialIds"])
      if (command[field] !== undefined) taskStrings(command[field]);
    if (command.allowAutoMaterials !== undefined)
      taskBoolean(command.allowAutoMaterials);
    if (command.type === "ai.plan" && !noteTypes.includes(command.step))
      invalid("任务规划步骤不正确");
    if (command.type === "ai.plan")
      for (const [field, max] of [["planningMaxWords", 300000], ["maxOutputTokens", 32000]] as const)
        if (command[field] !== undefined && (!Number.isSafeInteger(command[field]) || command[field] < 1 || command[field] > max))
          invalid("规划字数或单次输出上限不正确");
    if (command.type === "ai.chapter") {
      const ids = taskStrings(command.chapterIds);
      if (
        ![1, 3, 4, 5].includes(ids.length) ||
        new Set(ids).size !== ids.length ||
        (ids.length > 1 && command.authorizeBatch !== true)
      )
        invalid("任务批次授权或章节格式不正确");
      if (command.authorizeBatch !== undefined)
        taskBoolean(command.authorizeBatch);
      if (command.checkingProfileId !== undefined)
        text(command.checkingProfileId, true);
      if (
        command.chapterWords !== undefined &&
        (!Number.isSafeInteger(command.chapterWords) ||
          command.chapterWords < 1 ||
          command.chapterWords > 16000)
      )
        invalid("任务章节字数不正确");
    } else if (command.type === "ai.check" && command.chapterIds !== undefined)
      taskStrings(command.chapterIds);
    if (command.type === "ai.extract") {
      text(command.source, true);
      if (command.sourceText !== undefined) {
        text(command.sourceText, true);
        if (command.sourceText.length > 2000000)
          invalid("任务材料长度超过限制");
      }
      const input = request.inputText ?? command.sourceText;
      text(input, true);
      if (input.length > 2000000) invalid("任务材料长度超过限制");
    }
  }
  if (request.inputText !== undefined) {
    text(request.inputText);
    if (command.type !== "ai.extract") invalid("任务材料与类型不一致");
  }
  for (const field of ["profile", "checkingProfile"]) {
    const profile = taskObject(request[field]);
    taskFields(profile, ["id", "name", "baseUrl", "model", "purpose"]);
    for (const key of ["id", "name", "baseUrl", "model"])
      text(profile[key], true);
    if (!["planning", "writing", "checking"].includes(profile.purpose))
      invalid("任务模型用途不正确");
    let url: URL;
    try {
      url = new URL(profile.baseUrl);
    } catch {
      invalid("任务模型地址格式不正确");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      invalid("任务模型地址不能含凭据或查询参数");
    if (
      profile.id !==
      (field === "checkingProfile"
        ? (command.checkingProfileId ?? command.profileId)
        : command.profileId)
    )
      invalid("任务模型引用不一致");
  }
  const context = taskObject(request.context);
  taskFields(context, [
    "text",
    "sources",
    "documents",
    "disclosures",
    "materials", "storyStamp", "voiceText", "voiceStamp",
  ]);
  if(context.storyStamp!==undefined){const stamp=taskObject(context.storyStamp);taskFields(stamp,["beforeOrdinal","digest","writingJobId"]);if(!Number.isSafeInteger(stamp.beforeOrdinal)||stamp.beforeOrdinal<1||typeof stamp.digest!=="string"||!/^[a-f0-9]{64}$/.test(stamp.digest))invalid("任务状态依据格式不正确");if(stamp.writingJobId!==undefined)text(stamp.writingJobId,true);}
  if(context.voiceStamp!==undefined){validateVoiceStamp(context.voiceStamp);if(typeof context.voiceText!=="string")invalid("任务文风参考缺少实际元信息");}
  if(context.voiceText!==undefined&&(typeof context.voiceText!=="string"||!context.voiceStamp||context.voiceText.length>context.voiceStamp.limit))invalid("任务文风参考格式不正确");
  text(context.text);
  validateSources(context.sources);
  taskStrings(context.disclosures, 1000000);
  const sources = task.sourceRevisions as SourceRevision[];
  if (
    context.sources.length !== sources.length ||
    context.sources.some((s: any) => !matchingSource(s, sources))
  )
    invalid("任务上下文来源与任务快照不一致");
  const documents = taskArray(context.documents, 1000000);
  if (documents.length !== context.sources.length)
    invalid("任务上下文缺少来源正文");
  for (const document of documents) {
    const doc = taskObject(document);
    taskFields(doc, ["source", "text", "label", "candidateId"]);
    validateSources([doc.source]);
    text(doc.text);
    text(doc.label, true);
    if (!matchingSource(doc.source, context.sources))
      invalid("任务正文来源不一致");
    if (doc.candidateId !== undefined) text(doc.candidateId, true);
  }
  if (
    new Set(documents.map((doc) => `${doc.source.kind}:${doc.source.id}`))
      .size !== documents.length
  )
    invalid("任务来源正文重复");
  for (const material of taskArray(context.materials, 100000)) {
    const ref = taskObject(material);
    taskFields(ref, ["id", "snapshot"]);
    text(ref.id, true);
    const snap = taskObject(ref.snapshot);
    taskFields(snap, [
      "title",
      "type",
      "source",
      "content",
      "explanation",
      "approved",
      "revision",
    ]);
    for (const key of ["title", "source", "content"]) text(snap[key], true);
    text(snap.explanation);
    revision(snap.revision);
    if (!["expression", "plot"].includes(snap.type) || snap.approved !== true)
      invalid("任务引用素材未经审核");
  }
  if (sources.some((s) => s.kind === "project" && s.id !== task.projectId))
    invalid("任务来源作品归属不一致");
  if (
    command.type === "model.test" &&
    (sources.length || documents.length || context.materials.length)
  )
    invalid("连接任务不能包含作品来源");
  if (
    command.type === "ai.chapter" &&
    command.chapterIds.some(
      (id: string) => !sources.some((s) => s.kind === "chapter" && s.id === id),
    )
  )
    invalid("任务候选缺少目标章节来源");
  const result = taskObject(task.result);
  taskFields(result, [
    "candidates",
    "suggestion",
    "step",
    "sources",
    "disclosures",
    "materials",
    "check",
    "issueIds",
    "connection",
    "pauseReason",
    "phase",
    "checkProgress",
  ]);
  if (result.disclosures !== undefined)
    taskStrings(result.disclosures, 1000000);
  if (result.pauseReason !== undefined) text(result.pauseReason);
  if (result.sources !== undefined) {
    validateSources(result.sources);
    if (result.sources.some((s: any) => !matchingSource(s, sources)))
      invalid("任务结果来源不一致");
  }
  const candidates =
    result.candidates === undefined ? [] : taskArray(result.candidates, 5);
  if (task.kind !== "generation" && candidates.length)
    invalid("任务候选与任务类型不一致");
  if (new Set(candidates.map((c) => c?.chapterId)).size !== candidates.length)
    invalid("任务候选章节重复");
  for (const value of candidates) {
    const candidate = taskObject(value);
    taskFields(candidate, [
      "chapterId",
      "text",
      "versionId",
      "needsReview",
      "checked",
      "check",
      "lengthAttempts",
    ]);
    text(candidate.chapterId, true);
    text(candidate.text, true);
    taskBoolean(candidate.needsReview);
    taskBoolean(candidate.checked);
    if (
      candidate.lengthAttempts !== undefined &&
      ![1, 2].includes(candidate.lengthAttempts)
    )
      invalid("任务字数修订次数不正确");
    if (
      candidate.lengthAttempts !== undefined &&
      command.chapterWords === undefined
    )
      invalid("任务字数修订缺少目标");
    if (!command.chapterIds.includes(candidate.chapterId))
      invalid("任务候选不属于所选章节");
    if (candidate.versionId !== undefined) text(candidate.versionId, true);
    if (candidate.check !== undefined)
      validateTaskCheck(candidate.check, documents, candidates, sources);
    if (candidate.checked && candidate.check === undefined)
      invalid("任务候选缺少检查记录");
  }
  if (
    result.phase !== undefined &&
    (task.kind !== "generation" ||
      !["generation", "checking", "length"].includes(result.phase))
  )
    invalid("任务执行阶段不正确");
  if (
    result.phase === "length" &&
    (!command.chapterWords ||
      !candidates.some((c) => [1, 2].includes(c.lengthAttempts) && !c.checked))
  )
    invalid("任务字数修订阶段缺少待修订候选");
  if (result.suggestion !== undefined || result.step !== undefined) {
    if (task.kind !== "planning") invalid("任务建议与任务类型不一致");
    text(result.suggestion, true);
    if (result.step !== command.step) invalid("任务建议步骤不一致");
  }
  if (result.materials !== undefined) {
    if (task.kind !== "extraction") invalid("任务素材与任务类型不一致");
    for (const value of taskArray(result.materials, 100)) {
      const material = taskObject(value);
      taskFields(material, [
        "type",
        "title",
        "content",
        "explanation",
        "source",
        "approved",
      ]);
      if (
        !["expression", "plot"].includes(material.type) ||
        material.approved !== false ||
        material.source !== command.source
      )
        invalid("任务提取素材格式或来源不正确");
      text(material.title, true);
      text(material.content, true);
      text(material.explanation);
      text(material.source, true);
    }
  }
  if (result.check !== undefined) {
    if (task.kind !== "check") invalid("任务检查与任务类型不一致");
    validateTaskCheck(result.check, documents, candidates, sources);
  }
  if (result.checkProgress !== undefined) {
    const progress = taskObject(result.checkProgress);
    taskFields(progress, ["chapterId", "completed", "total", "checked"]);
    if (!["check", "generation"].includes(task.kind)) invalid("任务检查进度与类型不一致");
    if (!Number.isSafeInteger(progress.total) || progress.total < 1 ||
        !Number.isSafeInteger(progress.completed) || progress.completed < 0 || progress.completed > progress.total)
      invalid("任务检查覆盖进度不正确");
    if (task.kind === "generation") {
      if (!candidates.some(c => c.chapterId === progress.chapterId)) invalid("检查进度缺少对应候选");
    } else if (progress.chapterId !== undefined) invalid("全文检查进度不能包含候选章节");
    validateTaskCheck(progress.checked, documents, candidates, sources);
    if (task.status === "completed" && progress.completed !== progress.total) invalid("检查尚未覆盖全部分段");
  }
  if (result.issueIds !== undefined) {
    if (task.kind !== "check") invalid("任务问题与任务类型不一致");
    taskStrings(result.issueIds);
  }
  if (
    result.connection !== undefined &&
    (task.kind !== "connection" || result.connection !== true)
  )
    invalid("任务连接结果与类型不一致");
  if (
    task.status === "completed" &&
    (task.kind === "connection"
      ? result.connection !== true
      : task.kind !== "check" ||
        !result.check ||
        result.check.issues.length ||
        result.check.majorChange)
  )
    invalid("任务完成状态缺少有效结果");
}
function validateTaskCheck(
  value: unknown,
  documents: any[],
  candidates: any[],
  sources: SourceRevision[],
): void {
  const check = taskObject(value);
  taskFields(check, ["issues", "majorChange", "reason"]);
  taskBoolean(check.majorChange);
  if (check.reason !== undefined) text(check.reason);
  for (const value of taskArray(check.issues, 10000)) {
    const issue = taskObject(value);
    taskFields(issue, ["type", "reason", "evidence"]);
    if (
      ![
        "character",
        "timeline",
        "location",
        "world",
        "knowledge",
        "foreshadowing",
      ].includes(issue.type)
    )
      invalid("任务检查类型不正确");
    text(issue.reason, true);
    const evidence = taskArray(issue.evidence, 10);
    if (!evidence.length) invalid("任务检查缺少原文依据");
    for (const value of evidence) {
      const item = taskObject(value);
      taskFields(item, ["quote", "source", "candidateVersionId"]);
      text(item.quote, true);
      validateSources([item.source]);
      if (!matchingSource(item.source, sources)) invalid("任务检查来源不一致");
      if (item.candidateVersionId !== undefined) {
        text(item.candidateVersionId, true);
        if (
          !candidates.some(
            (c) =>
              c?.versionId === item.candidateVersionId &&
              c.chapterId === item.source.id &&
              typeof c.text === "string" &&
              c.text.includes(item.quote),
          )
        )
          invalid("任务检查候选依据不一致");
      } else if (
        !documents.some(
          (d) =>
            matchingSource(item.source, [d.source]) &&
            d.text.includes(item.quote),
        )
      )
        invalid("任务检查无法对应来源原文");
    }
  }
}
