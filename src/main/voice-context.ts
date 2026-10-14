import { createHash } from "node:crypto";
import type { AppState } from "../shared/types";
import type { VoiceRecord, VoiceFields, VoiceStamp } from "../shared/voice";
import { chapterDigest } from "./story-context";
export const sameVoiceSample = (a: VoiceRecord["samples"][number], b: VoiceRecord["samples"][number]) => a.id === b.id && a.chapterId === b.chapterId && a.revision === b.revision && a.start === b.start && a.end === b.end && a.quote === b.quote && a.contentHash === b.contentHash;
export function voiceSourcesCurrent(r: Omit<VoiceRecord, "history">, state: AppState) { const n = r.entityNoteId ? state.notes.find(n => n.id === r.entityNoteId) : undefined; return r.samples.every(s => { const c = state.chapters.find(c => c.id === s.chapterId); return !!c && c.projectId === r.projectId && c.revision === s.revision && c.ordinal === s.ordinal && chapterDigest(c) === s.contentHash && c.content.slice(s.start, s.end) === s.quote; }) && (r.kind !== "character" || !!n && n.projectId === r.projectId && n.type === "character" && !n.archived && !n.needsReview && n.revision === r.entityRevision); }
export function voiceAccepted(r: VoiceRecord, state: AppState) { const a = r.accepted; if (!a)
    return undefined; const trusted = a.samples.every(s => r.samples.some(current => current.approved && sameVoiceSample(current, s))); const stable = r.enabled && !r.archived && trusted && voiceSourcesCurrent(a, state) && a.samples.every(s => s.approved && state.chapters.find(c => c.id === s.chapterId)?.status === "confirmed" && !state.chapters.find(c => c.id === s.chapterId)?.needsReview); return { ...a, selectionOrder: r.selectionOrder ?? a.confirmationOrder, stable }; }
export interface VoiceReference {
    id: string;
    revision: number;
    kind: VoiceRecord["kind"];
    entityNoteId?: string;
    name: string;
    fields: VoiceFields;
}
export function voiceContext(state: AppState, projectId: string, query = "", limit = 8000) {
    query = query.slice(0, 4000);
    limit = Math.max(0, Math.min(8000, Math.floor(limit)));
    const project = state.projects.find(p => p.id === projectId);
    const candidates = (state.voiceRecords ?? []).filter(r => r.projectId === projectId && r.accepted).map(r => voiceAccepted(r, state)!).sort((a, b) => (b.selectionOrder ?? 0) - (a.selectionOrder ?? 0) || a.id.localeCompare(b.id));
    const latest = new Map<string, typeof candidates[number]>();
    for (const r of candidates) {
        const key = `${r.kind}:${r.entityNoteId ?? ""}`;
        if (!latest.has(key))
            latest.set(key, r);
    }
    const eligible = [...latest.values()].filter(r => r.kind === "narration" || query.includes(state.notes.find(n => n.id === r.entityNoteId)?.title ?? "\0"));
    const blockedCount = eligible.filter(r => !r.stable).length;
    const ordered = eligible.filter(r => r.stable && project && !project.archived).sort((a, b) => Number(b.kind === "narration") - Number(a.kind === "narration") || (b.selectionOrder ?? 0) - (a.selectionOrder ?? 0));
    const profiles: VoiceReference[] = [], selected: typeof candidates = [], warnings: string[] = [];
    const format = (p: VoiceReference[]) => p.length ? "【作者认可的表达参考；非剧情依据、非原文，不得据此新增事实或扩大回写范围】\n" + JSON.stringify(p) : "";
    for (const r of ordered) {
        const p: VoiceReference = { id: r.id, revision: r.revision, kind: r.kind, ...(r.entityNoteId ? { entityNoteId: r.entityNoteId } : {}), name: r.kind === "narration" ? "叙述文风" : state.notes.find(n => n.id === r.entityNoteId)!.title, fields: r.fields };
        if (profiles.length >= 5 || r.kind === "character" && profiles.filter(p => p.kind === "character").length >= 4 || format([...profiles, p]).length > limit) {
            warnings.push(`表达参考未纳入：${p.name}（本次窗口上限）`);
            continue;
        }
        profiles.push(p);
        selected.push(r);
    }
    const digest = createHash("sha256").update(JSON.stringify([profiles, selected.map(r => [r.id, r.revision, r.kind, r.fields, r.entityNoteId, r.entityRevision, r.samples])])).digest("hex");
    return { profiles, text: format(profiles), stamp: { query, limit, digest } as VoiceStamp, warnings, blockedCount };
}
export const voiceStampCurrent = (state: AppState, projectId: string, stamp: VoiceStamp, text?: string) => { const value = voiceContext(state, projectId, stamp.query, stamp.limit); return value.stamp.digest === stamp.digest && (text === undefined || value.text === text); };
export const voiceSourceDigest = (r: VoiceRecord) => createHash("sha256").update(JSON.stringify([r.id, r.revision, r.kind, r.entityNoteId, r.entityRevision, r.samples])).digest("hex");
