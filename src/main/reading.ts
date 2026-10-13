import { createHash, randomUUID } from "node:crypto";
import type { Chapter, CommandResult, RecordMeta } from "../shared/types";
import type {
  ReaderCommand,
  ReadingWorkspace,
  SearchResult,
} from "../shared/reader";
import { locateSelection } from "../shared/reader";
import { DomainError, invalid } from "../shared/validation";
import { DomainService } from "./domain";
import { Store } from "./store";

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) invalid("必填内容不能为空");
}
function integer(value: unknown, min?: number): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (min !== undefined && Number(value) < min)
  )
    invalid("位置或版本编号不正确");
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid("包含不支持的输入字段");
}
function validate(command: unknown): asserts command is ReaderCommand {
  object(command);
  text(command.type);
  text(command.projectId);
  const fields: Record<string, string[]> = {
    "reading.annotate": ["selection", "text"],
    "reading.annotationStatus": ["id", "status"],
    "reading.review": ["chapterId", "revision"],
    "reading.position": ["chapterId", "offset", "mode"],
    "reading.volumeSave": ["id", "title", "fromOrdinal", "toOrdinal"],
    "reading.volumeDelete": ["id"],
  };
  if (!Object.hasOwn(fields, command.type)) invalid("不支持的阅读操作");
  keys(command, ["type", "projectId", ...fields[command.type]]);
  switch (command.type) {
    case "reading.annotate": {
      text(command.text);
      object(command.selection);
      if (command.text.length > 10000) invalid("批注内容不能超过 10000 字符");
      const s = command.selection;
      keys(s, ["chapterId", "revision", "start", "end", "quote"]);
      text(s.chapterId);
      integer(s.revision, 1);
      integer(s.start, 0);
      integer(s.end, 1);
      if (
        typeof s.quote !== "string" ||
        !s.quote.length ||
        s.end <= s.start ||
        s.end - s.start !== s.quote.length
      )
        invalid("选区和引文不匹配");
      break;
    }
    case "reading.annotationStatus":
      text(command.id);
      if (command.status !== "open" && command.status !== "resolved")
        invalid("批注状态不正确");
      break;
    case "reading.review":
      text(command.chapterId);
      integer(command.revision, 1);
      break;
    case "reading.position":
      text(command.chapterId);
      integer(command.offset);
      if (command.mode !== "reading" && command.mode !== "review")
        invalid("阅读模式不正确");
      break;
    case "reading.volumeSave":
      if (command.id !== undefined) text(command.id);
      text(command.title);
      integer(command.fromOrdinal, 1);
      integer(command.toOrdinal, 1);
      if (command.fromOrdinal > command.toOrdinal)
        invalid("分卷章节范围不正确");
      break;
    case "reading.volumeDelete":
      text(command.id);
      break;
  }
}
function meta(): RecordMeta {
  const now = new Date().toISOString();
  return { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
}

export class ReadingService {
  constructor(
    private readonly store: Store,
    _domain: DomainService,
  ) {}

  dispatch(command: ReaderCommand): CommandResult {
    validate(command);
    return this.store.transaction(() => {
      this.project(command.projectId);
      const old = this.store.selectByProject(
        "readingWorkspaces",
        command.projectId,
      )[0];
      const workspace: ReadingWorkspace = old ?? {
        ...meta(),
        projectId: command.projectId,
        annotations: [],
        reviews: [],
        volumes: [],
      };
      let entityId = workspace.id;
      switch (command.type) {
        case "reading.annotate": {
          const c = this.chapter(
            command.projectId,
            command.selection.chapterId,
          );
          if (c.revision !== command.selection.revision)
            throw new DomainError("CONFLICT", "批注来源已变化，请重新选择正文");
          if (!locateSelection(c.content, command.selection, c.revision))
            invalid("选区与当前正文不匹配");
          const annotation = {
            ...meta(),
            chapterId: c.id,
            anchor: { ...command.selection },
            contentHash: createHash("sha256").update(c.content).digest("hex"),
            text: command.text.trim(),
            status: "open" as const,
          };
          workspace.annotations.push(annotation);
          entityId = annotation.id;
          break;
        }
        case "reading.annotationStatus": {
          const annotation = workspace.annotations.find(
            (a) => a.id === command.id,
          );
          if (!annotation)
            throw new DomainError("NOT_FOUND", "批注不存在，请刷新后重试");
          this.chapter(command.projectId, annotation.chapterId);
          annotation.status = command.status;
          annotation.revision++;
          annotation.updatedAt = new Date().toISOString();
          entityId = annotation.id;
          break;
        }
        case "reading.review": {
          const c = this.chapter(command.projectId, command.chapterId);
          if (c.revision !== command.revision)
            throw new DomainError("CONFLICT", "正文已变化，请重新审阅当前章节");
          const baseline = this.store
            .chapterVersions(c.id)
            .find(
              (v) =>
                v.projectId === c.projectId &&
                v.reason !== "ai-candidate" &&
                v.chapterRevision <= c.revision &&
                v.content === c.content,
            );
          if (!baseline)
            throw new DomainError(
              "CONFLICT",
              "当前正文缺少历史基准，请先保存章节再审阅",
            );
          workspace.reviews = workspace.reviews.filter(
            (r) => r.chapterId !== c.id,
          );
          workspace.reviews.push({
            chapterId: c.id,
            revision: c.revision,
            versionId: baseline.id,
            contentHash: createHash("sha256").update(c.content).digest("hex"),
            reviewedAt: new Date().toISOString(),
          });
          entityId = c.id;
          break;
        }
        case "reading.position": {
          const c = this.chapter(command.projectId, command.chapterId);
          workspace.position = {
            chapterId: c.id,
            offset: Math.max(0, Math.min(c.content.length, command.offset)),
            mode: command.mode,
          };
          break;
        }
        case "reading.volumeSave": {
          if (command.id && !workspace.volumes.some((v) => v.id === command.id))
            throw new DomainError("NOT_FOUND", "分卷不存在，请刷新后重试");
          const ordinals = new Set(
            this.store.chapterMetadata(command.projectId).map((c) => c.ordinal),
          );
          if (
            !ordinals.has(command.fromOrdinal) ||
            !ordinals.has(command.toOrdinal)
          )
            invalid("分卷边界必须是当前作品中的章节");
          if (
            workspace.volumes.some(
              (v) =>
                v.id !== command.id &&
                v.fromOrdinal <= command.toOrdinal &&
                command.fromOrdinal <= v.toOrdinal,
            )
          )
            invalid("分卷章节范围不能重叠");
          const volume = {
            id: command.id ?? randomUUID(),
            title: command.title.trim(),
            fromOrdinal: command.fromOrdinal,
            toOrdinal: command.toOrdinal,
          };
          workspace.volumes = workspace.volumes.filter(
            (v) => v.id !== volume.id,
          );
          workspace.volumes.push(volume);
          workspace.volumes.sort((a, b) => a.fromOrdinal - b.fromOrdinal);
          entityId = volume.id;
          break;
        }
        case "reading.volumeDelete": {
          if (!workspace.volumes.some((v) => v.id === command.id))
            throw new DomainError("NOT_FOUND", "分卷不存在，请刷新后重试");
          workspace.volumes = workspace.volumes.filter(
            (v) => v.id !== command.id,
          );
          entityId = command.id;
          break;
        }
      }
      if (old) {
        workspace.revision++;
        workspace.updatedAt = new Date().toISOString();
      }
      this.store.put("readingWorkspaces", workspace);
      return { ok: true, entityId, revision: workspace.revision };
    });
  }

  search(projectId: string, query: string, offset = 0): SearchResult {
    text(projectId);
    text(query);
    integer(offset, 0);
    this.project(projectId);
    return this.store.searchChapterText(projectId, query, offset);
  }

  private project(id: string) {
    if (!this.store.get("projects", id))
      throw new DomainError("NOT_FOUND", "作品不存在，请刷新后重试");
  }
  private chapter(projectId: string, id: string): Chapter {
    const c = this.store.get("chapters", id);
    if (!c) throw new DomainError("NOT_FOUND", "章节不存在，请刷新后重试");
    if (c.projectId !== projectId) invalid("该章节不属于当前作品");
    return c;
  }
}
