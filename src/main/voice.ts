import { randomUUID } from "node:crypto";
import { Store } from "./store";
import { DomainError } from "../shared/validation";
import { chapterDigest } from "./story-context";
import { validateVoiceCommand, validateVoiceRecord } from "../shared/voice-validation";
import type { VoiceCommand, VoiceSave, VoiceRecord, VoiceSampleInput, VoiceSample, VoiceQuery, VoiceWorkspace } from "../shared/voice";
import { voiceSourcesCurrent, voiceAccepted, sameVoiceSample, voiceContext } from "./voice-context";
export class VoiceService {
    constructor(private store: Store) { }
    private project(id: string) { const p = this.store.get("projects", id); if (!p || p.archived)
        throw new DomainError("NOT_FOUND", "作品不存在或已归档"); }
    record(id: string) { const r = this.store.get("voiceRecords", id); if (!r)
        throw new DomainError("NOT_FOUND", "文风档案不存在"); return r; }
    current(r: VoiceRecord) { return voiceSourcesCurrent(r, this.store.snapshot()); }
    private samples(projectId: string, inputs: VoiceSampleInput[], old?: VoiceRecord): VoiceSample[] { const known = new Set([...(old?.samples ?? []), ...(old?.history ?? []).flatMap(h => h.samples)].map(s => s.id)); const result = inputs.map(s => { if (s.id && !known.has(s.id))
        throw new DomainError("VALIDATION", "样本不属于这份档案"); const c = this.store.get("chapters", s.chapterId); if (!c || c.projectId !== projectId)
        throw new DomainError("VALIDATION", "样本来源不属于本作品"); if (c.revision !== s.revision || s.start < 0 || s.end > s.start + 4000 || s.end > c.content.length)
        throw new DomainError("CONFLICT", "样本原文已改变，请重新定位"); return { ...s, id: s.id ?? randomUUID(), quote: c.content.slice(s.start, s.end), ordinal: c.ordinal, contentHash: chapterDigest(c) }; }); if (result.reduce((n, s) => n + s.quote.length, 0) > 12000)
        throw new DomainError("VALIDATION", "样本合计最多12000字符"); return result; }
    save(c: VoiceSave, origin: VoiceRecord["origin"] = { kind: "manual" }) { validateVoiceCommand(c); return this.store.transaction(() => { this.project(c.projectId); const old = c.id ? this.record(c.id) : undefined; if (!!c.id !== (c.revision !== undefined) || old && (old.projectId !== c.projectId || old.revision !== c.revision))
        throw new DomainError("CONFLICT", "文风档案已改变，请重新读取"); const n = c.entityNoteId ? this.store.get("notes", c.entityNoteId) : undefined; if (c.kind === "character" ? (!n || n.projectId !== c.projectId || n.type !== "character" || n.archived) : !!c.entityNoteId)
        throw new DomainError("VALIDATION", "请绑定本作品有效人物资料"); const samples = this.samples(c.projectId, c.samples, old), trusted = !old?.accepted || old.accepted.samples.every(s => samples.some(next => next.approved && sameVoiceSample(s, next))); const now = new Date().toISOString(), { history, ...frame } = old ?? ({ history: [] } as any); const r: VoiceRecord = JSON.parse(JSON.stringify({ id: old?.id ?? randomUUID(), revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now, projectId: c.projectId, kind: c.kind, ...(n ? { entityNoteId: n.id, entityRevision: n.revision } : {}), fields: c.fields, samples, status: "candidate", enabled: !!old?.enabled && trusted, archived: old?.archived ?? false, ...(old?.selectionOrder ? { selectionOrder: old.selectionOrder } : {}), origin, history: old ? [...history, frame].slice(-50) : [], ...(old?.accepted ? { accepted: old.accepted } : {}) })); validateVoiceRecord(r); this.store.put("voiceRecords", r); return r; }); }
    command(c: Exclude<VoiceCommand, VoiceSave>) {
        validateVoiceCommand(c);
        if (!("revision" in c))
            throw new DomainError("VALIDATION", "文风操作不正确");
        return this.store.transaction(() => {
            const old = this.record(c.id);
            this.project(old.projectId);
            if (c.revision !== old.revision)
                throw new DomainError("CONFLICT", "文风档案已改变");
            if (c.type === "voice.restore") {
                const h = old.history.find(h => h.revision === c.historyRevision);
                if (!h)
                    throw new DomainError("NOT_FOUND", "文风历史不存在");
                const { history, ...frame } = old;
                // Restoring fields retains their original evidence; recognition must be granted again.
                const restored: VoiceRecord = { ...old, revision: old.revision + 1, updatedAt: new Date().toISOString(), kind: h.kind, fields: { ...h.fields }, samples: h.samples.map(s => ({ ...s, approved: false })), status: "candidate", enabled: false, origin: { kind: "manual" }, history: [...history, frame].slice(-50) };
                delete restored.entityNoteId;
                delete restored.entityRevision;
                if (h.entityNoteId) { restored.entityNoteId = h.entityNoteId; restored.entityRevision = h.entityRevision; }
                validateVoiceRecord(restored);
                this.store.put("voiceRecords", restored);
                return restored;
            }
            if (c.type === "voice.recheck") {
                const samples = old.samples.map(s => { const ch = this.store.get("chapters", s.chapterId); if (!ch || ch.projectId !== old.projectId)
                    throw new DomainError("CONFLICT", "样本来源已移除，请重新选择"); const start = ch.content.indexOf(s.quote); if (start < 0 || ch.content.indexOf(s.quote, start + 1) >= 0)
                    throw new DomainError("CONFLICT", "旧样本不存在或重复，请重新选择具体原文位置"); return { id: s.id, chapterId: ch.id, revision: ch.revision, start, end: start + s.quote.length, approved: s.approved && chapterDigest(ch) === s.contentHash }; });
                return this.save({ type: "voice.save", id: old.id, revision: old.revision, projectId: old.projectId, kind: old.kind, ...(old.entityNoteId ? { entityNoteId: old.entityNoteId } : {}), fields: old.fields, samples });
            }
            const { history, ...frame } = old;
            let next: VoiceRecord = { ...old, revision: old.revision + 1, updatedAt: new Date().toISOString(), history: [...history, frame].slice(-50) };
            if (c.type === "voice.confirm") {
                if (!Object.values(old.fields).some(v => v.trim()) || old.samples.some(s => !s.approved))
                    throw new DomainError("VALIDATION", "请先认可样本并填写或提取表达规则");
                const samples = old.samples.map(s => { const ch = this.store.get("chapters", s.chapterId); if (!ch || ch.projectId !== old.projectId || ch.status !== "confirmed" || ch.needsReview || chapterDigest(ch) !== s.contentHash || ch.content.slice(s.start, s.end) !== s.quote || ch.ordinal !== s.ordinal)
                    throw new DomainError("CONFLICT", "请先确认来源正文并复核样本"); return { ...s, revision: ch.revision }; });
                const rebound = { ...old, samples };
                if (!this.current(rebound))
                    throw new DomainError("CONFLICT", "人物资料或样本来源已改变，请复核");
                const order = Math.max(0, ...this.store.selectByProject("voiceRecords", old.projectId).map(r => r.selectionOrder ?? r.accepted?.confirmationOrder ?? 0)) + 1;
                next = { ...next, status: "confirmed", samples, enabled: true, confirmationOrder: order, selectionOrder: order };
                const { accepted, history, ...snapshot } = next;
                next.accepted = snapshot;
            }
            else if (c.type === "voice.reject")
                next.status = "rejected";
            else if (c.type === "voice.archive")
                next.archived = c.archived;
            else if (c.type === "voice.enable") {
                if (c.enabled && !voiceAccepted({ ...old, enabled: true }, this.store.snapshot())?.stable)
                    throw new DomainError("CONFLICT", "请先认可、确认并复核档案，才能启用");
                next.enabled = c.enabled;
                if (c.enabled) next.selectionOrder = Math.max(0, ...this.store.selectByProject("voiceRecords", old.projectId).map(r => r.selectionOrder ?? r.accepted?.confirmationOrder ?? 0)) + 1;
            }
            else
                throw new DomainError("VALIDATION", "文风操作不正确");
            validateVoiceRecord(next);
            this.store.put("voiceRecords", next);
            return next;
        });
    }
    workspace(q: VoiceQuery): VoiceWorkspace { if (!q || typeof q.projectId !== "string" || !q.projectId || q.offset !== undefined && (!Number.isSafeInteger(q.offset) || q.offset < 0) || q.limit !== undefined && (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 40) || q.archived !== undefined && typeof q.archived !== "boolean")
        throw new DomainError("VALIDATION", "文风查询范围不正确"); this.project(q.projectId); const state = this.store.snapshot(), records = (state.voiceRecords ?? []).filter(r => r.projectId === q.projectId && r.archived === (q.archived ?? false)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), offset = q.offset ?? 0, limit = q.limit ?? 40; const query = state.notes.filter(n => n.projectId === q.projectId && n.type === "character").map(n => n.title).join("\n"); return { records: records.slice(offset, offset + limit).map(r => ({ ...r, history: [], needsReview: !this.current(r), stable: !!voiceAccepted(r, state)?.stable, name: r.kind === "narration" ? "叙述文风" : state.notes.find(n => n.id === r.entityNoteId)?.title ?? "人物资料已移除" })), total: records.length, offset, nextOffset: offset + limit < records.length ? offset + limit : null, blockedCount: voiceContext(state, q.projectId, query).blockedCount, jobs: (state.voiceJobs ?? []).filter(j => j.projectId === q.projectId).slice(-5) }; }
}
