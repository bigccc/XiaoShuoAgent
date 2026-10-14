import type { ID, RecordMeta } from "./types";
import { DomainError } from "./validation";
export const voiceFieldNames = ["rhythm", "sentenceLength", "dialogueRatio", "descriptionDensity", "vocabulary", "avoid", "addresses", "catchphrases", "emotion"] as const;
export type VoiceFields = Record<typeof voiceFieldNames[number], string>;
export const emptyVoiceFields = (): VoiceFields => Object.fromEntries(voiceFieldNames.map(k => [k, ""])) as VoiceFields;
export interface VoiceStamp {
    query: string;
    limit: number;
    digest: string;
}
export interface VoiceSampleInput {
    id?: ID;
    chapterId: ID;
    revision: number;
    start: number;
    end: number;
    approved: boolean;
}
export interface VoiceSample extends VoiceSampleInput {
    id: ID;
    quote: string;
    contentHash: string;
    ordinal: number;
}
export interface VoiceRecord extends RecordMeta {
    projectId: ID;
    kind: "narration" | "character";
    entityNoteId?: ID;
    entityRevision?: number;
    fields: VoiceFields;
    samples: VoiceSample[];
    status: "candidate" | "confirmed" | "rejected";
    enabled: boolean;
    archived: boolean;
    confirmationOrder?: number;
    selectionOrder?: number;
    origin: {
        kind: "manual" | "extraction";
        id?: ID;
    };
    accepted?: Omit<VoiceRecord, "history" | "accepted">;
    history: Omit<VoiceRecord, "history">[];
}
export interface VoiceJob extends RecordMeta {
    projectId: ID;
    recordId: ID;
    recordRevision: number;
    sourceDigest: string;
    profileId?: ID;
    status: "running" | "paused" | "failed" | "cancelled" | "interrupted" | "completed";
    tokenBudget: number;
    budgetUsed: number;
    calls: number;
    usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
        estimated: boolean;
    } | null;
    reply: string;
    warnings: string[];
}
export interface VoiceRecordView extends VoiceRecord {
    needsReview: boolean;
    stable: boolean;
    name: string;
}
export interface VoiceWorkspace {
    records: VoiceRecordView[];
    total: number;
    offset: number;
    nextOffset: number | null;
    blockedCount: number;
    jobs: VoiceJob[];
}
export interface VoiceQuery {
    projectId: ID;
    offset?: number;
    limit?: number;
    archived?: boolean;
}
export type VoiceSave = {
    type: "voice.save";
    projectId: ID;
    id?: ID;
    revision?: number;
    kind: VoiceRecord["kind"];
    entityNoteId?: ID;
    fields: VoiceFields;
    samples: VoiceSampleInput[];
};
export type VoiceCommand = VoiceSave | {
    type: "voice.confirm" | "voice.reject" | "voice.recheck";
    id: ID;
    revision: number;
} | {
    type: "voice.enable";
    id: ID;
    revision: number;
    enabled: boolean;
} | {
    type: "voice.archive";
    id: ID;
    revision: number;
    archived: boolean;
} | {
    type: "voice.restore";
    id: ID;
    revision: number;
    historyRevision: number;
} | {
    type: "voice.extract";
    id: ID;
    revision: number;
    profileId?: ID;
    tokenBudget: number;
} | {
    type: "voice.pause" | "voice.cancel";
    id: ID;
} | {
    type: "voice.resume";
    id: ID;
    profileId?: ID;
    tokenBudget?: number;
};
export function validateVoiceStamp(v: unknown): asserts v is VoiceStamp { const s = v as VoiceStamp; if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some(k => !["query", "limit", "digest"].includes(k)) || typeof s.query !== "string" || s.query.length > 4000 || !Number.isSafeInteger(s.limit) || s.limit < 0 || s.limit > 8000 || typeof s.digest !== "string" || !/^[a-f0-9]{64}$/.test(s.digest))
    throw new DomainError("VALIDATION", "文风参考依据格式不正确"); }
