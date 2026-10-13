import {storyStampCurrent} from "./story-context";
import { randomUUID } from "node:crypto";
import type {
  AppState,
  CandidateInput,
  Chapter,
  ChapterVersion,
  Command,
  DomainCommand,
  CommandResult,
  ModelProfile,
  RecordMeta,
  SourceRevision,
} from "../shared/types";
import {
  DomainError,
  validateCandidate,
  validateCommand,
} from "../shared/validation";
import { Store, type Collection, type Entity } from "./store";
export interface DomainOptions {
  encryptKey?: (plaintext: string) => Uint8Array;
  onContentChange?: (command: DomainCommand, before: AppState) => void;
}
export class DomainService {
  constructor(
    private readonly store: Store,
    private readonly options: DomainOptions = {},
  ) {}
  snapshot(): AppState {
    return this.store.snapshot();
  }
  execute(command: Command): CommandResult {
    return this.result(() => {
      validateCommand(command);
      return this.store.transaction(() => {
        const before = this.options.onContentChange && ["project.update", "note.save", "note.delete"].includes(command.type) ? this.store.snapshot() : undefined;
        const result = this.apply(command);
        if (before && result.ok) {
          this.options.onContentChange!(command, before);
          const current = command.type.startsWith("note.") ? this.store.get("notes", result.entityId) : this.store.get("projects", result.entityId);
          if (current) return { ...result, revision: current.revision };
        }
        return result;
      });
    });
  }
  saveCandidate(input: CandidateInput): CommandResult {
    return this.result(() => {
      validateCandidate(input);
      return this.store.transaction(() => {
        const chapter = this.read("chapters", input.chapterId);
        this.checkSources(input.sourceRevisions);
        const task=this.store.get("tasks",input.taskId),stamp=(task?.requestSnapshot as any)?.context?.storyStamp;
        if(stamp&&!storyStampCurrent(this.store.snapshot(),chapter.projectId,stamp))throw new DomainError("CONFLICT","故事状态已改变，旧候选未写入");
        if (
          !input.sourceRevisions.some(
            (s) =>
              s.kind === "chapter" &&
              s.id === chapter.id &&
              s.revision === chapter.revision,
          )
        )
          throw new DomainError(
            "VALIDATION",
            "候选稿必须记录目标章节的当前版本",
          );
        const version = this.version(chapter, "ai-candidate", {
          content: input.content,
          status: "draft",
          taskId: input.taskId,
          sourceRevisions: input.sourceRevisions,
        });
        this.store.put("versions", version);
        return { ok: true, entityId: version.id };
      });
    });
  }
  private result(fn: () => CommandResult): CommandResult {
    try {
      return fn();
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof DomainError
            ? { code: e.code, message: e.message }
            : {
                code: "STORAGE",
                message: "本地保存失败，请检查磁盘空间和数据目录权限",
              },
      };
    }
  }
  private meta(): RecordMeta {
    const now = new Date().toISOString();
    return { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
  }
  private changed<T extends RecordMeta>(record: T): T {
    return {
      ...record,
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
    };
  }
  private read<K extends Collection>(
    table: K,
    id: string,
    revision?: number,
  ): Entity<K> {
    const record = this.store.get(table, id);
    if (!record)
      throw new DomainError("NOT_FOUND", "目标内容不存在，请刷新后重试");
    if (
      revision !== undefined &&
      (!("revision" in record) || record.revision !== revision)
    )
      throw new DomainError("CONFLICT", "内容已被修改，请刷新后重试");
    return record;
  }
  private checkSources(sources: SourceRevision[]): void {
    for (const source of sources)
      this.read(
        source.kind === "project"
          ? "projects"
          : source.kind === "note"
            ? "notes"
            : "chapters",
        source.id,
        source.revision,
      );
  }
  private invalidate(
    projectId: string,
    afterOrdinal?: number,
    changedNoteId?: string,
    upstream: SourceRevision[] = [],
  ): void {
    const notes = this.store
      .list("notes")
      .filter((n) => n.projectId === projectId);
    const chapters = this.store
      .list("chapters")
      .filter((c) => c.projectId === projectId);
    const key = (s: Pick<SourceRevision, "kind" | "id">) => `${s.kind}:${s.id}`;
    // A derived record cannot make its own ancestors obsolete. Follow the persisted
    // provenance graph, including chapter sources of indirectly referenced notes.
    const protectedKeys = new Set<string>();
    const pending = [...upstream];
    while (pending.length) {
      const source = pending.pop()!;
      if (protectedKeys.has(key(source))) continue;
      protectedKeys.add(key(source));
      if (source.kind === "note")
        pending.push(...(notes.find((n) => n.id === source.id)?.sources ?? []));
    }
    const affected = new Set<string>();
    if (changedNoteId) affected.add(`note:${changedNoteId}`);
    else if (afterOrdinal === undefined) affected.add(`project:${projectId}`);
    else
      for (const chapter of chapters)
        if (chapter.ordinal >= afterOrdinal)
          affected.add(`chapter:${chapter.id}`);
    const upstreamOrdinal = changedNoteId
      ? Math.max(
          0,
          ...chapters
            .filter((c) => protectedKeys.has(`chapter:${c.id}`))
            .map((c) => c.ordinal),
        )
      : 0;
    for (const chapter of chapters) {
      if (
        (afterOrdinal === undefined || chapter.ordinal > afterOrdinal) &&
        (!changedNoteId || chapter.ordinal > upstreamOrdinal) &&
        !protectedKeys.has(`chapter:${chapter.id}`)
      ) {
        affected.add(`chapter:${chapter.id}`);
        if (!chapter.needsReview)
          this.store.put("chapters", {
            ...this.changed(chapter),
            needsReview: true,
          });
      }
    }
    const changedNote = notes.find((n) => n.id === changedNoteId);
    // Unattributed manual outlines have no graph. Conservatively flag later planning
    // steps after setting changes; source-backed records follow only their real edges.
    const manualPlanningAffected = (type: string) =>
      afterOrdinal === undefined &&
      (changedNoteId === undefined ||
        (changedNote &&
          ["character", "world", "location", "storyline"].includes(
            changedNote.type,
          )) ||
        (changedNote?.type === "outline" && type === "chapterOutline"));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const note of notes) {
        const noteKey = `note:${note.id}`;
        if (
          note.id === changedNoteId ||
          protectedKeys.has(noteKey) ||
          affected.has(noteKey)
        )
          continue;
        if (
          note.sources.some((source) => affected.has(key(source))) ||
          (note.sources.length === 0 &&
            ["outline", "chapterOutline"].includes(note.type) &&
            manualPlanningAffected(note.type))
        ) {
          affected.add(noteKey);
          if (!note.needsReview)
            this.store.put("notes", {
              ...this.changed(note),
              needsReview: true,
            });
          progressed = true;
        }
      }
    }
  }
  private version(
    chapter: Chapter,
    reason: ChapterVersion["reason"],
    extra: Partial<ChapterVersion> = {},
  ): ChapterVersion {
    return {
      id: randomUUID(),
      chapterId: chapter.id,
      projectId: chapter.projectId,
      chapterRevision: chapter.revision,
      title: chapter.title,
      content: chapter.content,
      style: chapter.style,
      pace: chapter.pace,
      status: chapter.status,
      reason,
      createdAt: new Date().toISOString(),
      sourceRevisions: [],
      ...(chapter.writingStage ? { writingStage: chapter.writingStage } : {}),
      ...extra,
    };
  }
  private success(record: { id: string; revision?: number }): CommandResult {
    return {
      ok: true,
      entityId: record.id,
      ...(record.revision !== undefined ? { revision: record.revision } : {}),
    };
  }
  private apply(c: DomainCommand): CommandResult {
    switch (c.type) {
      case "project.create": {
        const p = {
          ...this.meta(),
          title: c.title.trim(),
          background: c.background ?? "",
          genre: c.genre ?? "",
          style: c.style ?? "",
          pace: c.pace ?? "",
          targetWords: c.targetWords ?? 100000,
          chapterWords: c.chapterWords ?? 3000,
          archived: false,
        };
        this.store.put("projects", p);
        return this.success(p);
      }
      case "project.update": {
        const p = this.read("projects", c.id, c.revision);
        const next = { ...this.changed(p), ...c.patch };
        if (c.patch.title) next.title = c.patch.title.trim();
        this.store.put("projects", next);
        if (Object.keys(c.patch).some((k) => k !== "title"))
          this.invalidate(p.id);
        return this.success(next);
      }
      case "project.archive": {
        const p = {
          ...this.changed(this.read("projects", c.id, c.revision)),
          archived: c.archived ?? true,
        };
        this.store.put("projects", p);
        return this.success(p);
      }
      case "note.save": {
        this.read("projects", c.projectId);
        this.checkSources(c.sources);
        const old = c.id ? this.read("notes", c.id, c.revision) : undefined;
        if (old && old.projectId !== c.projectId)
          throw new DomainError("VALIDATION", "不能将设定移动到其他作品");
        const note = {
          ...(old ? this.changed(old) : this.meta()),
          projectId: c.projectId,
          type: c.noteType,
          title: c.title.trim(),
          body: c.body,
          ...(old?.archived ? { archived: false } : {}),
          ...(old ? { history: old.type !== c.noteType || old.title !== c.title.trim() || old.body !== c.body
            ? [...(old.history ?? []), { revision: old.revision, type: old.type, title: old.title, body: old.body, createdAt: old.updatedAt }]
            : old.history ?? [] } : {}),
          sources: c.sources,
          needsReview: false,
        };
        this.store.put("notes", note);
        this.invalidate(c.projectId, undefined, note.id, note.sources);
        return this.success(this.read("notes", note.id));
      }
      case "note.delete": {
        const n = this.read("notes", c.id, c.revision);
        this.invalidate(n.projectId, undefined, n.id, n.sources);
        this.store.remove("notes", n.id);
        return this.success(n);
      }
      case "chapter.create": {
        this.read("projects", c.projectId);
        if (
          this.store
            .list("chapters")
            .some(
              (ch) => ch.projectId === c.projectId && ch.ordinal === c.ordinal,
            )
        )
          throw new DomainError("VALIDATION", "同一作品的章节序号不能重复");
        const chapter: Chapter = {
          ...this.meta(),
          projectId: c.projectId,
          ordinal: c.ordinal,
          title: c.title.trim(),
          content: "",
          status: "draft",
          needsReview: false,
          style: c.style ?? "",
          pace: c.pace ?? "",
        };
        this.store.put("chapters", chapter);
        this.store.put("versions", this.version(chapter, "create"));
        return this.success(chapter);
      }
      case "chapter.save": {
        const old = this.read("chapters", c.id, c.revision);
        const chapter: Chapter = {
          ...this.changed(old),
          content: c.content,
          title: c.title?.trim() ?? old.title,
          style: c.style ?? old.style,
          pace: c.pace ?? old.pace,
          status: "draft",
          needsReview: old.needsReview,
        };
        this.store.put("chapters", chapter);
        this.store.put("versions", this.version(chapter, "save"));
        this.invalidate(chapter.projectId, chapter.ordinal);
        return this.success(chapter);
      }
      case "chapter.confirm": {
        const old = this.read("chapters", c.id, c.revision);
        if (!old.content.trim())
          throw new DomainError("VALIDATION", "空白章节不能确认");
        const chapter: Chapter = {
          ...this.changed(old),
          status: "confirmed",
          needsReview: false,
        };
        this.store.put("chapters", chapter);
        this.store.put("versions", this.version(chapter, "confirm"));
        return this.success(chapter);
      }
      case "chapter.restore": {
        const old = this.read("chapters", c.id, c.revision);
        const v = this.read("versions", c.versionId);
        if (v.chapterId !== old.id)
          throw new DomainError("VALIDATION", "该版本不属于此章节");
        const chapter: Chapter = {
          ...this.changed(old),
          title: v.title,
          content: v.content,
          style: v.style,
          pace: v.pace,
          writingStage: v.writingStage ?? "complete",
          status: "draft",
          needsReview: old.needsReview || v.reason === "ai-candidate",
        };
        this.store.put("chapters", chapter);
        this.store.put(
          "versions",
          this.version(chapter, "restore", {
            restoredFrom: v.id,
            sourceRevisions: v.sourceRevisions,
          }),
        );
        this.invalidate(chapter.projectId, chapter.ordinal);
        return this.success(chapter);
      }
      case "material.save": {
        const old = c.id ? this.read("materials", c.id, c.revision) : undefined;
        const material = {
          ...(old ? this.changed(old) : this.meta()),
          type: c.materialType,
          title: c.title.trim(),
          source: c.source,
          content: c.content,
          explanation: c.explanation,
          approved: c.approved,
          projectReferences: old?.projectReferences ?? [],
        };
        this.store.put("materials", material);
        return this.success(material);
      }
      case "material.link": {
        const old = this.read("materials", c.id, c.revision);
        this.read("projects", c.projectId);
        if (
          c.linked !== false &&
          old.projectReferences.some((ref) => ref.projectId === c.projectId)
        )
          return this.success(old);
        if (c.linked !== false && !old.approved)
          throw new DomainError("VALIDATION", "请先审核素材再选用");
        const refs = old.projectReferences.filter(
          (ref) => ref.projectId !== c.projectId,
        );
        if (c.linked !== false)
          refs.push({
            projectId: c.projectId,
            linkedAt: new Date().toISOString(),
            snapshot: {
              title: old.title,
              type: old.type,
              source: old.source,
              content: old.content,
              explanation: old.explanation,
              approved: old.approved,
              revision: old.revision,
            },
          });
        const next = { ...this.changed(old), projectReferences: refs };
        this.store.put("materials", next);
        return this.success(next);
      }
      case "material.delete": {
        const m = this.read("materials", c.id, c.revision);
        if (m.projectReferences.length)
          throw new DomainError("VALIDATION", "素材仍被作品引用，请先取消引用");
        this.store.remove("materials", m.id);
        return this.success(m);
      }
      case "profile.save": {
        const old = c.id ? this.read("profiles", c.id, c.revision) : undefined;
        const profile: ModelProfile = {
          ...(old ? this.changed(old) : this.meta()),
          name: c.name.trim(),
          baseUrl: c.baseUrl,
          model: c.model,
          purpose: c.purpose,
          hasKey: old ? this.store.hasProfileKey(old.id) : false,
        };
        if (c.apiKey !== undefined) {
          if (c.apiKey.length) {
            if (!this.options.encryptKey)
              throw new DomainError(
                "KEY_PROTECTION",
                "系统密钥保护不可用，不能保存 API 密钥",
              );
            let encrypted: Uint8Array;
            try {
              encrypted = this.options.encryptKey(c.apiKey);
            } catch {
              throw new DomainError(
                "KEY_PROTECTION",
                "系统密钥保护失败，密钥未保存",
              );
            }
            this.store.setProfileKey(profile.id, encrypted);
            profile.hasKey = true;
          } else {
            this.store.setProfileKey(profile.id, null);
            profile.hasKey = false;
          }
        }
        this.store.put("profiles", profile);
        return this.success(profile);
      }
      case "profile.delete": {
        const profile = this.read("profiles", c.id, c.revision);
        this.store.remove("profiles", profile.id);
        this.store.setProfileKey(profile.id, null);
        return this.success(profile);
      }
      case "issue.resolve": {
        const issue = {
          ...this.changed(this.read("issues", c.id, c.revision)),
          status: c.status,
        };
        this.store.put("issues", issue);
        return this.success(issue);
      }
    }
  }
}
