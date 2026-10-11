import type { PlanningStage, StageBinding } from "../../../src/shared/types";

// Compatibility fixtures classify the complete source without consuming a conversation turn.
export function normalizationReply(body: { messages?: { content?: string }[] }) {
  if (!body.messages?.some((m) => m.content?.includes("STAGE_SYNC_NORMALIZE"))) return;
  const input = JSON.parse(body.messages.at(-1)!.content!) as {
    stage: PlanningStage; text: string; lineCount: number; bindings: StageBinding[];
  };
  return {
    stage: input.stage,
    blocks: input.text.trim() ? [input.stage === "outline"
      ? { kind: "note", noteType: "outline", title: "故事大纲", startLine: 1, endLine: input.lineCount,
          ...(input.bindings.find((b) => b.noteId)?.noteId ? { noteId: input.bindings.find((b) => b.noteId)!.noteId } : {}) }
      : { kind: "field", field: input.stage === "overview" ? "background" : "style", startLine: 1, endLine: input.lineCount }] : [],
    removeNoteIds: input.stage === "outline" && input.text.trim() ? [] : input.bindings.flatMap((b) => b.noteId ? [b.noteId] : []),
    removeFields: input.text.trim() ? [] : input.bindings.flatMap((b) => b.field ? [b.field] : []),
  };
}
