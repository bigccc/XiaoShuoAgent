import { z } from "zod";
import { DomainError } from "./validation";
import { voiceFieldNames } from "./voice";
import type { VoiceRecord, VoiceJob, VoiceCommand, VoiceFields } from "./voice";
const id = z.string().min(1).max(200), rev = z.number().int().min(1), digest = z.string().regex(/^[a-f0-9]{64}$/), budget = z.number().int().min(1).max(1000000);
const meta = { id, revision: rev, createdAt: z.string().datetime(), updatedAt: z.string().datetime() };
const fields = z.object(Object.fromEntries(voiceFieldNames.map(k => [k, z.string().max(400)]))).strict();
const sampleInput = { id: id.optional(), chapterId: id, revision: rev, start: z.number().int().min(0), end: z.number().int().min(1), approved: z.boolean() };
const input = z.object(sampleInput).strict().refine(s => s.end > s.start && s.end - s.start <= 4000);
const sample = z.object({ ...sampleInput, id, quote: z.string().min(1).max(4000), contentHash: digest, ordinal: rev }).strict().refine(s => s.end - s.start === s.quote.length);
const shape = { ...meta, projectId: id, kind: z.enum(["narration", "character"]), entityNoteId: id.optional(), entityRevision: rev.optional(), fields, samples: z.array(sample).min(1).max(6), status: z.enum(["candidate", "confirmed", "rejected"]), enabled: z.boolean(), archived: z.boolean(), confirmationOrder: rev.optional(), origin: z.object({ kind: z.enum(["manual", "extraction"]), id: id.optional() }).strict() };
const accepted = z.object(shape).strict(), frame = accepted.extend({ accepted: accepted.optional() }).strict(), record = frame.extend({ history: z.array(frame).max(50) }).strict();
const usage = z.object({ inputTokens: z.number().int().min(0).nullable(), outputTokens: z.number().int().min(0).nullable(), totalTokens: z.number().int().min(0).nullable(), estimated: z.boolean() }).strict().nullable();
const job = z.object({ ...meta, projectId: id, recordId: id, recordRevision: rev, sourceDigest: digest, profileId: id.optional(), status: z.enum(["running", "paused", "failed", "cancelled", "interrupted", "completed"]), tokenBudget: budget, budgetUsed: z.number().int().min(0), calls: z.number().int().min(0), usage, reply: z.string().max(4000), warnings: z.array(z.string().max(1000)).max(100) }).strict();
function check(s: z.ZodType, v: unknown) { if (!s.safeParse(v).success)
    throw new DomainError("VALIDATION", "文风档案、样本或任务格式不正确"); }
export function validateVoiceFields(v: unknown): asserts v is VoiceFields { check(fields, v); }
export function validateVoiceRecord(v: unknown): asserts v is VoiceRecord {
    check(record, v);
    const r = v as VoiceRecord;
    const frames = [r, ...r.history, ...[r.accepted, ...r.history.map(h => h.accepted)].filter(Boolean)];
    for (const f of frames) {
        if (f!.id !== r.id || f!.projectId !== r.projectId || f!.revision > r.revision || f!.samples.reduce((n, s) => n + s.quote.length, 0) > 12000 || new Set(f!.samples.map(s => s.id)).size !== f!.samples.length || (f!.kind === "character" ? (!f!.entityNoteId || !f!.entityRevision) : f!.entityNoteId !== undefined || f!.entityRevision !== undefined) || f!.status === "confirmed" && (!f!.confirmationOrder || f!.samples.some(s => !s.approved) || !Object.values(f!.fields).some(s => s.trim())))
            throw new DomainError("VALIDATION", "文风样本归属、认可或历史快照不正确");
    }
    if (r.accepted && (r.accepted.status !== "confirmed" || !r.accepted.enabled) || r.status === "confirmed" && !r.accepted || r.history.some((h, i) => h.revision >= r.revision || i > 0 && h.revision <= r.history[i - 1].revision))
        throw new DomainError("VALIDATION", "文风采纳与历史版本不正确");
}
export function validateVoiceJob(v: unknown): asserts v is VoiceJob { check(job, v); }
export function validateVoiceCommand(v: unknown): asserts v is VoiceCommand {
    const existing = { id, revision: rev };
    check(z.discriminatedUnion("type", [
        z.object({ type: z.literal("voice.save"), projectId: id, id: id.optional(), revision: rev.optional(), kind: z.enum(["narration", "character"]), entityNoteId: id.optional(), fields, samples: z.array(input).min(1).max(6) }).strict(),
        ...["voice.confirm", "voice.reject", "voice.recheck"].map(t => z.object({ type: z.literal(t), ...existing }).strict()),
        z.object({ type: z.literal("voice.enable"), ...existing, enabled: z.boolean() }).strict(), z.object({ type: z.literal("voice.archive"), ...existing, archived: z.boolean() }).strict(),
        z.object({ type: z.literal("voice.restore"), ...existing, historyRevision: rev }).strict(), z.object({ type: z.literal("voice.extract"), ...existing, profileId: id.optional(), tokenBudget: budget }).strict(),
        z.object({ type: z.literal("voice.pause"), id }).strict(), z.object({ type: z.literal("voice.cancel"), id }).strict(), z.object({ type: z.literal("voice.resume"), id, profileId: id.optional(), tokenBudget: budget.optional() }).strict(),
    ]), v);
}
