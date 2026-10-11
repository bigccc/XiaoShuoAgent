import { randomUUID } from "node:crypto";
import type {
  AppState,
  AuthoringState,
  DomainCommand,
  Note,
  PlanningStage,
  Project,
  StageBinding,
  StageBundle,
  StageSyncBatch,
  StageSyncJob,
  StageSyncSnapshot,
  SyncConflict,
  SyncField,
} from "../shared/types";
import {
  newDocument,
  planningStages,
  readAuthoring,
  validateAuthoring,
} from "../shared/authoring";
import {
  fieldLabels,
  materializeBundle,
  renderStage,
  stageNoteTypes,
  syncFields,
} from "../shared/sync";
import { DomainError } from "../shared/validation";
import { writeDocument } from "./authoring";
import { Store } from "./store";
import { DomainService } from "./domain";
const meta = () => {
  const now = new Date().toISOString();
  return { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
};
const fields = (p: Project): StageSyncSnapshot["fields"] => ({
  title: p.title,
  genre: p.genre,
  background: p.background,
  style: p.style,
  pace: p.pace,
});
const sameNote = (a: Note, b: Note) =>
  a.title === b.title &&
  a.body === b.body &&
  a.type === b.type &&
  !!a.archived === !!b.archived;
export class SyncState {
  applying = false;
  constructor(
    readonly store: Store,
    private domain: DomainService,
  ) {}
  updateJob(id: string, patch: Partial<StageSyncJob>) {
    const old = this.store.get("syncJobs", id);
    if (!old) throw new DomainError("NOT_FOUND", "同步任务不存在");
    const next = {
      ...old,
      ...patch,
      revision: old.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (Object.hasOwn(patch, "proposal") && patch.proposal === undefined)
      delete next.proposal;
    this.store.put("syncJobs", next);
    return next;
  }
  newJob(
    projectId: string,
    stage: PlanningStage,
    text: string,
    documentRevision: number,
    profileId?: string,
  ): StageSyncJob {
    const p = this.store.get("projects", projectId);
    if (!p) throw new DomainError("NOT_FOUND", "作品不存在");
    const job: StageSyncJob = {
      ...meta(),
      projectId,
      stage,
      sourceContent: text,
      documentRevision,
      baseProjectRevision: p.revision,
      baseNoteRevisions: this.store
        .list("notes")
        .filter((n) => n.projectId === projectId)
        .map((n) => ({ id: n.id, revision: n.revision })),
      status: "pending",
      conflicts: [],
      summary: [],
      calls: 0,
      usage: null,
      ...(profileId ? { profileId } : {}),
    };
    this.store.put("syncJobs", job);
    return job;
  }
  captureJobSource(id: string) {
    const job = this.store.get("syncJobs", id)!;
    const p = this.store.get("projects", job.projectId)!;
    this.updateJob(id, {
      baseProjectRevision: p.revision,
      documentRevision: p.authoring?.documents[job.stage]?.revision ?? 0,
      baseNoteRevisions: this.store
        .list("notes")
        .filter((n) => n.projectId === job.projectId)
        .map((n) => ({ id: n.id, revision: n.revision })),
    });
  }
  assertJobSource(job: StageSyncJob) {
    const p = this.store.get("projects", job.projectId)!;
    const notes = this.store
      .list("notes")
      .filter((n) => n.projectId === job.projectId);
    if (
      p.revision !== job.baseProjectRevision ||
      p.authoring?.documents[job.stage]?.revision !== job.documentRevision ||
      notes.length !== job.baseNoteRevisions.length ||
      job.baseNoteRevisions.some(
        (n) => !notes.some((c) => c.id === n.id && c.revision === n.revision),
      )
    ) {
      const doc = p.authoring?.documents[job.stage];
      if (doc && doc.revision !== job.documentRevision)
        this.updateJob(job.id, {
          proposal: undefined,
          sourceContent: doc.content,
        });
      this.captureJobSource(job.id);
      throw new DomainError(
        "CONFLICT",
        "资料在差异展示后又有修改，请查看最新内容再处理",
      );
    }
  }
  mark(
    projectId: string,
    stage: PlanningStage,
    status: "pending" | "running" | "failed" | "conflict",
    jobId?: string,
    error?: string,
  ) {
    const p = this.store.get("projects", projectId)!;
    const workflow = readAuthoring(this.store.snapshot(), p),
      doc = workflow.documents[stage];
    if (!doc) return;
    const old = doc.sync;
    doc.approved = false;
    doc.sync = {
      status,
      bindings: old?.bindings ?? [],
      lastSyncedContent: old?.lastSyncedContent ?? "",
      lastSyncedRevision: old?.lastSyncedRevision ?? 0,
      ...(old?.batchId ? { batchId: old.batchId } : {}),
      ...(jobId ? { jobId } : old?.jobId ? { jobId: old.jobId } : {}),
      ...(error ? { error } : {}),
    };
    this.putProject(p, workflow);
  }
  private putProject(p: Project, workflow: AuthoringState) {
    validateAuthoring(workflow);
    this.store.put("projects", {
      ...p,
      authoring: workflow,
      revision: p.revision + 1,
      updatedAt: new Date().toISOString(),
    });
  }
  private command(c: DomainCommand) {
    const r = this.domain.execute(c);
    if (!r.ok) throw new DomainError(r.error.code, r.error.message);
    return r;
  }
  conflicts(
    projectId: string,
    bundle: StageBundle,
    workflow?: AuthoringState,
  ): SyncConflict[] {
    const p = this.store.get("projects", projectId)!;
    const wf = workflow ?? readAuthoring(this.store.snapshot(), p);
    const bindings = wf.documents[bundle.stage]?.sync?.bindings ?? [];
    const notes = this.store
      .list("notes")
      .filter((n) => n.projectId === projectId);
    const result: SyncConflict[] = [];
    for (const [index, block] of bundle.blocks.entries()) {
      if (block.kind !== "note") continue;
      if (block.noteId) {
        const old = notes.find((n) => n.id === block.noteId);
        if (
          old &&
          !old.syncManaged &&
          !bindings.some((b) => b.noteId === old.id) &&
          (old.body !== block.text || old.title !== block.title)
        )
          result.push({
            blockId: block.id ?? `block-${index}`,
            title: block.title!,
            reason: "首次关联的现有手工记录有不同内容",
            noteIds: [old.id],
          });
        continue;
      }
      const exact = notes.filter(
        (n) =>
          !n.archived &&
          n.type === block.noteType &&
          n.title === block.title &&
          n.body === block.text,
      );
      if (exact.length === 1) continue;
      const candidates = notes.filter(
        (n) =>
          !n.archived && n.type === block.noteType && n.title === block.title,
      );
      if (exact.length > 1 || candidates.length)
        result.push({
          blockId: block.id ?? `block-${index}`,
          title: block.title!,
          reason:
            exact.length > 1
              ? "存在同名同正文的多个记录，请明确身份"
              : "辅助工具已有不同内容，请确认采用哪份",
          noteIds: candidates.map((n) => n.id),
        });
    }
    for (const id of bundle.removeNoteIds ?? [])
      if (!bindings.some((b) => b.noteId === id))
        throw new DomainError("VALIDATION", "只能移除当前阶段已关联的记录");
    return result;
  }
  assertSource(captured: AppState, projectId: string, stage?: PlanningStage) {
    const old = captured.projects.find((p) => p.id === projectId)!,
      current = this.store.get("projects", projectId)!;
    if (JSON.stringify(fields(old)) !== JSON.stringify(fields(current)))
      throw new DomainError("CONFLICT", "作品字段在整理期间已变化");
    const currentNotes = this.store
        .list("notes")
        .filter((n) => n.projectId === projectId),
      oldNotes = captured.notes.filter((n) => n.projectId === projectId);
    if (
      currentNotes.length !== oldNotes.length ||
      oldNotes.some(
        (n) =>
          !currentNotes.some((c) => c.id === n.id && c.revision === n.revision),
      )
    )
      throw new DomainError("CONFLICT", "辅助资料在整理期间已变化");
    if (stage) {
      const a = old.authoring?.documents[stage],
        b = current.authoring?.documents[stage];
      if (a?.revision !== b?.revision || a?.content !== b?.content)
        throw new DomainError(
          "CONFLICT",
          "阶段全文已有新版本，旧整理结果不能写回",
        );
    }
  }
  commit(
    projectId: string,
    raw: StageBundle,
    workflow: AuthoringState,
    jobId: string,
    origin: StageSyncBatch["origin"],
    force = false,
    links: Record<string, string | null> = {},
    cohort: PlanningStage[] = [raw.stage],
  ): AuthoringState {
    const bundle = materializeBundle(raw);
    return this.store.transaction(() => {
      const p = this.store.get("projects", projectId)!;
      const beforeState = this.store.snapshot();
      const previousDoc = p.authoring?.documents[bundle.stage];
      const beforeBindings = previousDoc?.sync?.bindings ?? [];
      const conflict = this.conflicts(projectId, bundle, {
        ...workflow,
        documents: {
          ...workflow.documents,
          [bundle.stage]: previousDoc ?? workflow.documents[bundle.stage],
        },
      });
      if (conflict.length && !force) {
        this.updateJob(jobId, {
          status: "conflict",
          proposal: bundle,
          conflicts: conflict,
          error: "需要确认现有资料差异",
        });
        throw new DomainError(
          "CONFLICT",
          "现有资料存在差异，请选择保留阶段草稿或辅助记录",
        );
      }
      const allNotes = this.store
        .list("notes")
        .filter((n) => n.projectId === projectId);
      const touched = new Set(
        beforeBindings.flatMap((b) => (b.noteId ? [b.noteId] : [])),
      );
      const selectedNotes = new Map<number, string | undefined>();
      for (const [index, b] of bundle.blocks.entries()) {
        if (b.kind !== "note") continue;
        let target = b.noteId;
        const resolution = links[b.id ?? `block-${index}`];
        if (resolution !== undefined) target = resolution ?? undefined;
        if (!target && resolution !== null) {
          const exact = allNotes.filter(
            (n) =>
              !n.archived &&
              n.type === b.noteType &&
              n.title === b.title &&
              n.body === b.text,
          );
          if (exact.length === 1) target = exact[0].id;
          else if (force) {
            const candidates = allNotes.filter(
              (n) =>
                !n.archived && n.type === b.noteType && n.title === b.title,
            );
            if (candidates.length === 1) target = candidates[0].id;
            else if (candidates.length > 1)
              throw new DomainError(
                "CONFLICT",
                "同名记录需要明确选择，不能自动合并",
              );
          }
        }
        if (target && !allNotes.some((n) => n.id === target))
          throw new DomainError("VALIDATION", "同步不能引用其他作品或未知记录");
        if (target) touched.add(target);
        selectedNotes.set(index, target);
      }
      const before: StageSyncSnapshot = {
        fields: fields(p),
        notes: allNotes.filter((n) => touched.has(n.id)),
        bindings: structuredClone(beforeBindings),
        content:
          previousDoc?.sync?.lastSyncedContent ?? previousDoc?.content ?? "",
      };
      const bindings: StageBinding[] = [],
        summaries: string[] = [];
      const priorApplying = this.applying;
      this.applying = true;
      try {
        const patch: Partial<Project> = {};
        for (const f of bundle.removeFields ?? [])
          patch[f] = f === "title" ? "未命名故事" : "";
        for (const [index, b] of bundle.blocks.entries()) {
          const text = b.text!;
          if (b.kind === "field") {
            if (b.field === "title" && !text.trim())
              throw new DomainError("VALIDATION", "书名不能为空");
            patch[b.field!] = text;
            bindings.push({
              id:
                b.id ??
                beforeBindings.find((x) => x.field === b.field)?.id ??
                randomUUID(),
              kind: "field",
              field: b.field!,
              heading: b.heading ?? true,
            });
          } else {
            const target = selectedNotes.get(index),
              old = target ? this.store.get("notes", target) : undefined;
            let noteId = target;
            if (
              !old ||
              old.title !== b.title ||
              old.body !== text ||
              old.type !== b.noteType ||
              old.archived
            ) {
              noteId = this.command({
                type: "note.save",
                projectId,
                ...(old ? { id: old.id, revision: old.revision } : {}),
                noteType: b.noteType!,
                title: b.title!,
                body: text,
                sources: [],
              }).entityId;
              summaries.push(`${old ? "更新" : "新增"}：${b.title}`);
            }
            const record = this.store.get("notes", noteId!)!;
            this.store.put("notes", {
              ...record,
              archived: false,
              ...(old
                ? old.syncManaged
                  ? { syncManaged: true }
                  : {}
                : { syncManaged: true }),
              ...(b.noteType === "supplement"
                ? { supplementStage: old?.supplementStage ?? bundle.stage }
                : {}),
              needsReview: false,
            });
            touched.add(noteId!);
            bindings.push({
              id:
                b.id ??
                beforeBindings.find((x) => x.noteId === noteId)?.id ??
                randomUUID(),
              kind: "note",
              noteId: noteId!,
              heading: b.heading ?? true,
            });
          }
        }
        const omitted = beforeBindings
          .filter(
            (b) => b.noteId && !bindings.some((n) => n.noteId === b.noteId),
          )
          .map((b) => b.noteId!);
        if (omitted.some((id) => !(bundle.removeNoteIds ?? []).includes(id)))
          throw new DomainError(
            "VALIDATION",
            "原关联记录没有明确去向；必须保留或明确移除",
          );
        for (const id of bundle.removeNoteIds ?? []) {
          const old = this.store.get("notes", id)!;
          const elsewhere = planningStages.some(
            (s) =>
              s !== bundle.stage &&
              workflow.documents[s]?.sync?.bindings.some(
                (b) => b.noteId === id,
              ),
          );
          if (old.syncManaged && !elsewhere && !old.archived) {
            this.store.put("notes", {
              ...old,
              archived: true,
              revision: old.revision + 1,
              updatedAt: new Date().toISOString(),
            });
            summaries.push(`归档：${old.title}`);
          } else summaries.push(`解除关联：${old.title}`);
          touched.add(id);
        }
        const nowProject = this.store.get("projects", projectId)!;
        const changedPatch = Object.fromEntries(
          Object.entries(patch).filter(
            ([key, value]) => nowProject[key as SyncField] !== value,
          ),
        );
        if (Object.keys(changedPatch).length)
          this.command({
            type: "project.update",
            id: projectId,
            revision: nowProject.revision,
            patch: changedPatch,
          });
        summaries.push(
          ...Object.keys(changedPatch).map(
            (f) => `更新：${fieldLabels[f as SyncField]}`,
          ),
        );
        // All projected records are reconciled together; mark only their final state clean.
        for (const b of bindings)
          if (b.noteId) {
            const n = this.store.get("notes", b.noteId)!;
            this.store.put("notes", { ...n, needsReview: false });
          }
        const content = renderStage(bindings, this.store.snapshot(), projectId);
        if (content.length > 30000)
          throw new DomainError(
            "VALIDATION",
            "阶段全文超过三万字符，原文保留，请分批整理",
          );
        const next = structuredClone(workflow);
        writeDocument(next, bundle.stage, content);
        const doc = next.documents[bundle.stage]!;
        const batch: StageSyncBatch = {
          ...meta(),
          projectId,
          stage: bundle.stage,
          jobId,
          origin,
          before,
          after: {
            fields: fields(this.store.get("projects", projectId)!),
            notes: this.store.list("notes").filter((n) => touched.has(n.id)),
            bindings,
            content,
          },
        };
        this.store.put("syncBatches", batch);
        if (
          previousDoc?.sync?.batchId &&
          previousDoc.sync.status === "synced" &&
          previousDoc.content === previousDoc.sync.lastSyncedContent
        ) {
          const h = doc.history.find(
            (h) => h.revision === previousDoc.revision,
          );
          if (h) h.batchId = previousDoc.sync.batchId;
        }
        doc.sync = {
          status: "synced",
          bindings,
          lastSyncedContent: content,
          lastSyncedRevision: doc.revision,
          jobId,
          batchId: batch.id,
        };
        this.putProject(this.store.get("projects", projectId)!, next);
        this.updateJob(jobId, {
          status: "succeeded",
          proposal: bundle,
          summary: summaries.length ? summaries : ["资料内容一致，关联已核对"],
          conflicts: [],
        });
        this.applying = false;
        for (const id of touched) {
          const n = this.store.get("notes", id);
          if (n)
            this.reverse(
              {
                type: "note.save",
                projectId,
                id: n.id,
                revision: n.revision,
                noteType: n.type,
                title: n.title,
                body: n.body,
                sources: n.sources,
              },
              beforeState,
              cohort,
              origin,
            );
        }
        return this.store.get("projects", projectId)!.authoring!;
      } finally {
        this.applying = priorApplying;
      }
    });
  }
  reverse(
    command: DomainCommand,
    beforeState: AppState,
    excluded: PlanningStage[] = [],
    origin: StageSyncBatch["origin"] = "auxiliary",
  ) {
    if (this.applying) return;
    const projectId =
      command.type === "note.save"
        ? command.projectId
        : command.type === "note.delete"
          ? beforeState.notes.find((n) => n.id === command.id)?.projectId
          : command.type === "project.update"
            ? command.id
            : undefined;
    if (!projectId) return;
    const oldProject = beforeState.projects.find((p) => p.id === projectId),
      p = this.store.get("projects", projectId);
    if (!p?.authoring || !oldProject) return;
    const workflow = structuredClone(p.authoring);
    const affected = new Set<PlanningStage>();
    if (command.type === "note.save" && command.id) {
      const old = beforeState.notes.find((n) => n.id === command.id),
        current = this.store.get("notes", command.id);
      if (old && current && old.type !== current.type) {
        let moved: StageBinding | undefined;
        for (const s of planningStages) {
          const d = workflow.documents[s];
          if (d?.sync && !stageNoteTypes[s].includes(current.type as any)) {
            moved ??= d.sync.bindings.find((b) => b.noteId === current.id);
            if (d.sync.bindings.some((b) => b.noteId === current.id)) {
              d.sync.bindings = d.sync.bindings.filter(
                (b) => b.noteId !== current.id,
              );
              affected.add(s);
            }
          }
        }
        const destination =
          current.type === "supplement"
            ? (current.supplementStage ?? "settings")
            : planningStages.find((s) =>
                stageNoteTypes[s].includes(current.type as any),
              );
        if (moved && destination) {
          const d = (workflow.documents[destination] ??= newDocument(""));
          d.sync ??= {
            status: "synced",
            bindings: [],
            lastSyncedContent: d.content,
            lastSyncedRevision: d.revision,
          };
          if (!d.sync.bindings.some((b) => b.noteId === current.id))
            d.sync.bindings.push({ ...moved, heading: true });
          affected.add(destination);
        }
      }
    }
    // Explicitly saving an archived managed record restores its prior binding,
    // preserving identity instead of leaving a resurrected orphan note.
    if (command.type === "note.save" && command.id) {
      const old = beforeState.notes.find((n) => n.id === command.id),
        current = this.store.get("notes", command.id);
      if (old?.archived && old.syncManaged && current && !current.archived) {
        const previous = [...this.store.list("syncBatches")]
          .reverse()
          .find(
            (b) =>
              b.projectId === projectId &&
              b.before.bindings.some((x) => x.noteId === old.id),
          );
        const binding = previous?.before.bindings.find(
          (b) => b.noteId === old.id,
        );
        const doc = previous ? workflow.documents[previous.stage] : undefined;
        if (
          doc?.sync &&
          binding &&
          !doc.sync.bindings.some((b) => b.noteId === old.id)
        )
          doc.sync.bindings = [...doc.sync.bindings, binding];
      }
    }
    let changed = false;
    for (const stage of planningStages) {
      if (excluded.includes(stage)) continue;
      const doc = workflow.documents[stage];
      const original = oldProject.authoring?.documents[stage];
      const oldDoc = original?.sync
        ? original
        : {
            ...newDocument(original?.content ?? ""),
            sync: {
              status: "synced" as const,
              bindings: [] as StageBinding[],
              lastSyncedContent: original?.content ?? "",
              lastSyncedRevision: 1,
            },
          };
      if (!doc?.sync) continue;
      const oldSync = oldDoc.sync!;
      const noteId =
        command.type === "note.save" || command.type === "note.delete"
          ? command.id
          : undefined;
      const changedFields =
        command.type === "project.update"
          ? Object.keys(command.patch).filter(
              (f) =>
                syncFields.includes(f as SyncField) &&
                oldProject[f as SyncField] !== p[f as SyncField],
            )
          : [];
      if (
        !affected.has(stage) &&
        !doc.sync.bindings.some(
          (b) =>
            (noteId !== undefined && b.noteId === noteId) ||
            (b.field && changedFields.includes(b.field)),
        )
      )
        continue;
      if (command.type === "note.delete") {
        const old = beforeState.notes.find((n) => n.id === command.id)!;
        if (old.syncManaged)
          this.store.put("notes", {
            ...old,
            revision: old.revision + 1,
            archived: true,
            updatedAt: new Date().toISOString(),
          });
      }
      if (
        noteId &&
        command.type === "note.save" &&
        beforeState.notes.find((n) => n.id === noteId)?.title !==
          this.store.get("notes", noteId)?.title
      )
        doc.sync.bindings = doc.sync.bindings.map((b) =>
          b.noteId === noteId ? { ...b, heading: true } : b,
        );
      const boundIds = [
        ...new Set(
          [...oldSync.bindings, ...doc.sync.bindings].flatMap((b) =>
            b.noteId ? [b.noteId] : [],
          ),
        ),
      ];
      const bindings = doc.sync.bindings.filter(
        (b) =>
          !b.noteId ||
          (this.store.get("notes", b.noteId) &&
            !this.store.get("notes", b.noteId)!.archived),
      );
      const content = renderStage(bindings, this.store.snapshot(), projectId);
      if (doc.sync.status !== "synced" && doc.content !== content) {
        const job = this.newJob(projectId, stage, doc.content, doc.revision);
        this.updateJob(job.id, {
          status: "conflict",
          conflicts: [
            {
              blockId: "concurrent",
              title: "阶段全文与辅助资料",
              reason: "两边都有未合并修改",
              noteIds: noteId ? [noteId] : [],
            },
          ],
          error: "两边都有修改，需要选择保留内容",
        });
        doc.approved = false;
        doc.sync = {
          ...doc.sync,
          status: "conflict",
          jobId: job.id,
          error: "辅助资料已修改，阶段草稿完整保留",
        };
        changed = true;
        continue;
      }
      if (
        doc.sync.status === "synced" &&
        content === doc.content &&
        JSON.stringify(bindings) === JSON.stringify(doc.sync.bindings) &&
        !affected.has(stage)
      )
        continue;
      if (content.length > 30000)
        throw new DomainError(
          "VALIDATION",
          "更新后的阶段全文超过长度限制，请分批编辑",
        );
      const job = this.newJob(projectId, stage, content, doc.revision + 1);
      const batch: StageSyncBatch = {
        ...meta(),
        projectId,
        stage,
        jobId: job.id,
        origin,
        before: {
          fields: fields(oldProject),
          notes: beforeState.notes.filter((n) => boundIds.includes(n.id)),
          bindings: oldSync.bindings,
          content: oldDoc.content,
        },
        after: {
          fields: fields(this.store.get("projects", projectId)!),
          notes: this.store
            .list("notes")
            .filter((n) => boundIds.includes(n.id)),
          bindings,
          content,
        },
      };
      this.store.put("syncBatches", batch);
      writeDocument(workflow, stage, content);
      const updated = workflow.documents[stage]!;
      const h = updated.history.find((h) => h.revision === oldDoc.revision);
      if (h && oldSync.batchId) h.batchId = oldSync.batchId;
      updated.sync = {
        status: "synced",
        bindings,
        lastSyncedContent: content,
        lastSyncedRevision: updated.revision,
        jobId: job.id,
        batchId: batch.id,
      };
      if (origin !== "auxiliary") updated.needsReview = oldDoc.needsReview;
      if (origin === "auxiliary") workflow.activeStage = stage;
      this.updateJob(job.id, {
        status: "succeeded",
        summary: ["辅助资料修改已同步到阶段全文"],
      });
      changed = true;
    }
    if (changed) {
      this.putProject(this.store.get("projects", projectId)!, workflow);
      for (const stage of planningStages) {
        const d = workflow.documents[stage];
        if (
          d?.sync?.status === "conflict" &&
          d.sync.jobId &&
          oldProject.authoring?.documents[stage]?.sync?.jobId !== d.sync.jobId
        )
          this.captureJobSource(d.sync.jobId);
      }
    }
  }
  useRecords(projectId: string, stage: PlanningStage, jobId: string) {
    return this.store.transaction(() => {
      const p = this.store.get("projects", projectId)!,
        workflow = readAuthoring(this.store.snapshot(), p),
        doc = workflow.documents[stage]!;
      let bindings = doc.sync?.bindings ?? [];
      const job = this.store.get("syncJobs", jobId)!;
      if (!bindings.length && job.proposal)
        bindings = job.proposal.blocks.flatMap<StageBinding>((b) => {
          if (b.kind === "field")
            return [
              {
                id: b.id ?? randomUUID(),
                kind: "field" as const,
                field: b.field!,
                heading: b.heading ?? true,
              },
            ];
          const ids = b.noteId
            ? [b.noteId]
            : (job.conflicts.find((c) => c.blockId === b.id)?.noteIds ?? []);
          return ids
            .filter(
              (id) =>
                this.store.get("notes", id)?.projectId === projectId &&
                !this.store.get("notes", id)?.archived,
            )
            .map((id, index) => ({
              id: index === 0 ? (b.id ?? randomUUID()) : randomUUID(),
              kind: "note" as const,
              noteId: id,
              heading: b.heading ?? true,
            }));
        });
      const content = renderStage(bindings, this.store.snapshot(), projectId);
      const ids = [
        ...new Set(
          [...(doc.sync?.bindings ?? []), ...bindings].flatMap((b) =>
            b.noteId ? [b.noteId] : [],
          ),
        ),
      ];
      const batch: StageSyncBatch = {
        ...meta(),
        projectId,
        stage,
        jobId,
        origin: "auxiliary",
        before: {
          fields: fields(p),
          notes: this.store.list("notes").filter((n) => ids.includes(n.id)),
          bindings: doc.sync?.bindings ?? [],
          content: doc.content,
        },
        after: {
          fields: fields(p),
          notes: this.store.list("notes").filter((n) => ids.includes(n.id)),
          bindings,
          content,
        },
      };
      this.store.put("syncBatches", batch);
      writeDocument(workflow, stage, content);
      const next = workflow.documents[stage]!;
      next.sync = {
        status: "synced",
        bindings,
        lastSyncedContent: content,
        lastSyncedRevision: next.revision,
        jobId,
        batchId: batch.id,
      };
      this.putProject(p, workflow);
      this.updateJob(jobId, {
        status: "succeeded",
        conflicts: [],
        summary: ["已保留辅助工具修改，阶段草稿保存在历史"],
      });
    });
  }
  restore(
    projectId: string,
    stage: PlanningStage,
    revision: number,
    historyRevision: number,
  ) {
    const p = this.store.get("projects", projectId);
    if (!p) throw new DomainError("NOT_FOUND", "作品不存在");
    if (p.revision !== revision)
      throw new DomainError("CONFLICT", "作品已变化，请重新查看历史");
    const workflow = readAuthoring(this.store.snapshot(), p),
      doc = workflow.documents[stage],
      history = doc?.history.find((h) => h.revision === historyRevision);
    if (!history) throw new DomainError("NOT_FOUND", "历史成果不存在");
    const batch = history.batchId
      ? this.store.get("syncBatches", history.batchId)
      : undefined;
    if (!batch) return { content: history.content };
    const target = batch.after;
    const bundle: StageBundle = {
      stage,
      blocks: target.bindings.map((b) =>
        b.kind === "field"
          ? {
              id: b.id,
              kind: "field",
              field: b.field!,
              text: target.fields[b.field!],
              ...(b.heading === undefined ? {} : { heading: b.heading }),
            }
          : (() => {
              const n = target.notes.find((n) => n.id === b.noteId)!;
              return {
                id: b.id,
                kind: "note" as const,
                noteId: n.id,
                noteType: n.type as any,
                title: n.title,
                text: n.body,
                ...(b.heading === undefined ? {} : { heading: b.heading }),
              };
            })(),
      ),
      removeNoteIds: (doc?.sync?.bindings ?? [])
        .filter(
          (b) =>
            b.noteId && !target.bindings.some((t) => t.noteId === b.noteId),
        )
        .map((b) => b.noteId!),
      removeFields: (doc?.sync?.bindings ?? [])
        .filter(
          (b) => b.field && !target.bindings.some((t) => t.field === b.field),
        )
        .map((b) => b.field!),
    };
    const job = this.newJob(projectId, stage, history.content, doc!.revision);
    const orderedBatches = this.store.list("syncBatches");
    const laterIndependent = orderedBatches
      .slice(orderedBatches.findIndex((b) => b.id === batch.id) + 1)
      .some(
        (b) =>
          b.projectId === projectId &&
          b.origin === "auxiliary" &&
          (b.after.notes.some(
            (n) =>
              target.notes.some((t) => t.id === n.id) &&
              !b.before.notes.some(
                (old) => old.id === n.id && sameNote(old, n),
              ),
          ) ||
            Object.keys(b.after.fields).some(
              (f) =>
                target.bindings.some((t) => t.field === f) &&
                b.before.fields[f as SyncField] !==
                  b.after.fields[f as SyncField],
            )),
      );
    if (laterIndependent) {
      this.updateJob(job.id, {
        status: "conflict",
        proposal: bundle,
        conflicts: [
          {
            blockId: "restore",
            title: "恢复历史",
            reason: "相关辅助记录之后有独立修改",
            noteIds: target.notes.map((n) => n.id),
          },
        ],
      });
      this.mark(
        projectId,
        stage,
        "conflict",
        job.id,
        "恢复涉及后续独立修改，需要确认",
      );
      this.captureJobSource(job.id);
      return { jobId: job.id };
    }
    this.commit(projectId, bundle, workflow, job.id, "restore", true);
    return { jobId: job.id };
  }
}
