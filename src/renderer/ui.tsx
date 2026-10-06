import { cloneElement, useId, type ReactNode, type ReactElement } from "react";
import type { AppState, SourceRevision, NoteType } from "../shared/types";
export const noteNames: Record<NoteType, string> = {
  character: "人物与关系",
  world: "世界规则",
  location: "场景与地点",
  storyline: "主线与支线",
  outline: "全书／分卷大纲",
  chapterOutline: "近期章纲",
  summary: "正文摘要",
  timeline: "时间线",
  knowledge: "角色知情",
  foreshadowing: "伏笔进展",
};
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children as ReactElement<{ id?: string }>, { id })}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">✦</div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
export function SaveStatus({
  editor,
}: {
  editor: {
    status: string;
    failed: boolean;
    retry: () => Promise<boolean>;
    reload: () => void;
  };
}) {
  return (
    <div
      className={"save-state " + (editor.failed ? "danger" : "")}
      role="status"
    >
      ● {editor.status}
      {editor.failed && (
        <>
          <button onClick={() => void editor.retry()}>重试保存</button>
          <button onClick={editor.reload}>放弃编辑并重新载入</button>
        </>
      )}
    </div>
  );
}
export function Sources({
  sources,
  state,
}: {
  sources: SourceRevision[];
  state: AppState;
}) {
  return (
    <div className="sources">
      {sources.map((s, i) => {
        const item =
          s.kind === "chapter"
            ? state.chapters.find((x) => x.id === s.id)
            : s.kind === "note"
              ? state.notes.find((x) => x.id === s.id)
              : state.projects.find((x) => x.id === s.id);
        return (
          <span
            key={i}
            className={item?.revision === s.revision ? "" : "danger"}
          >
            {item?.title ?? "已删除来源"} · 版本 {s.revision}
            {item?.revision !== s.revision ? "（来源已变化）" : ""}
          </span>
        );
      })}
    </div>
  );
}
export function sourceIsCurrent(source: SourceRevision, state: AppState) {
  const list =
    source.kind === "project"
      ? state.projects
      : source.kind === "note"
        ? state.notes
        : state.chapters;
  return list.find((x) => x.id === source.id)?.revision === source.revision;
}
export function reviewedSources(
  sources: SourceRevision[],
  state: AppState,
): SourceRevision[] {
  return sources.flatMap((s) => {
    const list =
      s.kind === "project"
        ? state.projects
        : s.kind === "note"
          ? state.notes
          : state.chapters;
    const item = list.find((x) => x.id === s.id);
    return item ? [{ ...s, revision: item.revision }] : [];
  });
}
export function sourceFingerprint(sources: SourceRevision[], state: AppState) {
  return sources
    .map((s) => {
      const list =
        s.kind === "project"
          ? state.projects
          : s.kind === "note"
            ? state.notes
            : state.chapters;
      return `${s.kind}:${s.id}@${list.find((x) => x.id === s.id)?.revision ?? "deleted"}`;
    })
    .join("|");
}
