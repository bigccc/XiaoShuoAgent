import type { ConversationResponse, ConversationTurn } from "./types";
import { DomainError, validatePublicJson } from "./validation";
import { authoringStages, planningStages } from "./authoring";
import { validateBundle } from "./sync";

const noteTypes = [
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
function fail(): never {
  throw new DomainError(
    "VALIDATION",
    "创作回复格式不完整，请重试；现有正文未被修改",
  );
}
function object(
  value: unknown,
  keys: string[],
): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail();
}
function string(
  value: unknown,
  max: number,
  empty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    fail();
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
}
export function validateConversationResponse(
  value: unknown,
): asserts value is ConversationResponse {
  object(value, [
    "message",
    "suggestions",
    "memory",
    "project",
    "notes",
    "chapters",
    "proposal",
    "artifacts",
  ]);
  string(value.message, 12000);
  if (value.artifacts !== undefined) {
    list(value.artifacts, 3);
    for (const item of value.artifacts) {
      object(item, [
        "stage",
        "content",
        "blocks",
        "removeNoteIds",
        "removeFields",
      ]);
      if (!planningStages.includes(item.stage)) fail();
      if (item.content !== undefined) string(item.content, 30000);
      if (item.blocks !== undefined)
        validateBundle({
          stage: item.stage,
          blocks: item.blocks,
          ...(item.removeNoteIds ? { removeNoteIds: item.removeNoteIds } : {}),
          ...(item.removeFields ? { removeFields: item.removeFields } : {}),
        });
      else if (item.content === undefined) fail();
    }
  }
  if (value.memory !== undefined) string(value.memory, 8000, true);
  if (value.suggestions !== undefined) {
    list(value.suggestions, 3);
    value.suggestions.forEach((s) => string(s, 300));
  }
  if (value.project !== undefined) {
    object(value.project, ["title", "background", "genre", "style", "pace"]);
    for (const [key, v] of Object.entries(value.project))
      string(v, key === "background" ? 12000 : 500, key !== "title");
  }
  if (value.notes !== undefined) {
    list(value.notes, 20);
    for (const n of value.notes) {
      object(n, ["id", "type", "title", "body"]);
      if (n.id !== undefined) string(n.id, 200);
      if (!noteTypes.includes(n.type)) fail();
      string(n.title, 200);
      string(n.body, 20000);
    }
  }
  if (value.chapters !== undefined) {
    list(value.chapters, 5);
    for (const c of value.chapters) {
      object(c, ["id", "title", "content", "stage"]);
      if (c.id !== undefined) string(c.id, 200);
      string(c.title, 200);
      string(c.content, 100000);
      if (!["opening", "complete"].includes(c.stage)) fail();
    }
  }
  if (value.proposal !== undefined) {
    object(value.proposal, ["chapterIds", "reason"]);
    list(value.proposal.chapterIds, 5);
    if (!value.proposal.chapterIds.length) fail();
    value.proposal.chapterIds.forEach((id) => string(id, 200));
    string(value.proposal.reason, 2000);
  }
  validatePublicJson(value);
}
export function parseConversationResponse(text: string): ConversationResponse {
  let value: unknown;
  try {
    value = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    fail();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const dto = value as Record<string, unknown>;
    for (const key of [
      "artifacts",
      "suggestions",
      "memory",
      "project",
      "notes",
      "chapters",
      "proposal",
    ])
      if (dto[key] === null) delete dto[key];
  }
  validateConversationResponse(value);
  return value;
}
export function validateConversationTurn(
  value: unknown,
): asserts value is ConversationTurn {
  object(value, [
    "id",
    "revision",
    "createdAt",
    "updatedAt",
    "projectId",
    "text",
    "reply",
    "status",
    "suggestions",
    "chapterIds",
    "memory",
    "contextWarnings",
    "usage",
    "profileId",
    "chapterId",
    "proposalTurnId",
    "proposal",
    "response",
    "rawResponse",
    "error",
    "authoringIntent",
    "authoringSource",
  ]);
  for (const k of ["id", "projectId"]) string(value[k], 200);
  for (const k of ["profileId", "chapterId", "proposalTurnId"])
    if (value[k] !== undefined) string(value[k], 200);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    fail();
  if (value.rawResponse !== undefined) string(value.rawResponse, 300000);
  string(value.text, 10000);
  if (value.authoringSource !== undefined) string(value.authoringSource, 64);
  if (value.authoringIntent !== undefined) {
    const intent = value.authoringIntent;
    object(intent, [
      "targetStage",
      "outputStages",
      "approveStages",
      "allowWriting",
      "preview",
      "delegated",
      "reconciliation",
    ]);
    if (!authoringStages.includes(intent.targetStage)) fail();
    for (const key of ["outputStages", "approveStages"]) {
      list(intent[key], 3);
      if (intent[key].some((s: any) => !planningStages.includes(s))) fail();
    }
    for (const key of [
      "allowWriting",
      "preview",
      "delegated",
      "reconciliation",
    ])
      if (typeof intent[key] !== "boolean") fail();
  }
  string(value.reply, 16000, true);
  string(value.memory, 8000, true);
  if (
    ![
      "running",
      "completed",
      "awaiting-author",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(value.status)
  )
    fail();
  for (const [field, max] of [
    ["suggestions", 3],
    ["chapterIds", 5],
    ["contextWarnings", 1000],
  ] as const) {
    list(value[field], max);
    value[field].forEach((v: unknown) => string(v, 2000));
  }
  if (value.error !== undefined) string(value.error, 2000);
  if (value.response !== undefined)
    validateConversationResponse(value.response);
  if (value.proposal !== undefined)
    validateConversationResponse({
      message: "proposal",
      proposal: value.proposal,
    });
  if (value.usage !== null) {
    object(value.usage, [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "estimated",
    ]);
    if (typeof value.usage.estimated !== "boolean") fail();
    for (const k of ["inputTokens", "outputTokens", "totalTokens"])
      if (
        value.usage[k] !== null &&
        (!Number.isSafeInteger(value.usage[k]) || value.usage[k] < 0)
      )
        fail();
  }
  validatePublicJson(value);
}
