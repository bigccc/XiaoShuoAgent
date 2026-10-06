import type { Project, AppState, Note, NoteType } from "../shared/types";
import type { Run } from "./api";
import { useEditor, type Register } from "./editing";
import {
  Field,
  SaveStatus,
  noteNames,
  Empty,
  Sources,
  sourceIsCurrent,
  reviewedSources,
  sourceFingerprint,
} from "./ui";
import { useState, useRef, useCallback } from "react";
export function ProjectSettings({
  project,
  run,
  register,
}: {
  project: Project;
  run: Run;
  register: Register;
}) {
  const editor = useEditor(
    project,
    (p) => ({
      title: p.title,
      background: p.background,
      genre: p.genre,
      style: p.style,
      pace: p.pace,
      targetWords: p.targetWords,
      chapterWords: p.chapterWords,
    }),
    (p, v) => ({
      type: "project.update",
      id: p.id,
      revision: p.revision,
      patch: v,
    }),
    run,
    register,
  );
  const v = editor.value;
  return (
    <section className="page">
      <div className="eyebrow">01 / 故事的起点</div>
      <h1>创意与风格</h1>
      <p>先抓住你最想写的那一点，再决定故事的声音。</p>
      <SaveStatus editor={editor} />
      <div className="form-grid">
        <Field label="作品名称">
          <input
            value={v.title}
            onChange={(e) => editor.edit({ ...v, title: e.target.value })}
          />
        </Field>
        <Field label="题材">
          <input
            value={v.genre}
            onChange={(e) => editor.edit({ ...v, genre: e.target.value })}
            placeholder="都市轻喜剧、奇幻…"
          />
        </Field>
      </div>
      <Field label="简介与背景">
        <textarea
          className="background"
          value={v.background}
          onChange={(e) => editor.edit({ ...v, background: e.target.value })}
          placeholder="一句创意、核心冲突、时代背景与看点"
        />
      </Field>
      <div className="form-grid">
        <Field label="作品文风">
          <textarea
            value={v.style}
            onChange={(e) => editor.edit({ ...v, style: e.target.value })}
            placeholder="叙述语气、人物说话习惯…"
          />
        </Field>
        <Field label="叙事节奏">
          <textarea
            value={v.pace}
            onChange={(e) => editor.edit({ ...v, pace: e.target.value })}
            placeholder="轻快、悬念、反转与铺垫…"
          />
        </Field>
        <Field label="目标总字数">
          <input
            type="number"
            min="1"
            value={v.targetWords}
            onChange={(e) =>
              editor.edit({ ...v, targetWords: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="每章目标字数">
          <input
            type="number"
            min="1"
            value={v.chapterWords}
            onChange={(e) =>
              editor.edit({ ...v, chapterWords: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <div className="hint">
        下一步：人物与世界 → 故事规划 → 近期章纲 → 正文。你随时可以返回修改。
      </div>
    </section>
  );
}
export function Notes({
  state,
  projectId,
  planning,
  run,
  register,
}: {
  state: AppState;
  projectId: string;
  planning: boolean;
  run: Run;
  register: Register;
}) {
  const [selected, setSelected] = useState("");
  const notes = state.notes.filter(
    (n) =>
      n.projectId === projectId &&
      (planning
        ? !["character", "world", "location"].includes(n.type)
        : ["character", "world", "location"].includes(n.type)),
  );
  const note = notes.find((n) => n.id === selected) ?? notes[0];
  const activeFlush = useRef(async () => true);
  async function choose(id: string) {
    if (await activeFlush.current()) setSelected(id);
  }
  const noteRegister: Register = useCallback(
    (flush) => {
      activeFlush.current = flush;
      const cleanup = register(flush);
      return () => {
        cleanup();
        activeFlush.current = async () => true;
      };
    },
    [register],
  );
  return (
    <div className="split-page">
      <aside className="item-list">
        <h2>{planning ? "故事规划" : "人物与世界"}</h2>
        <button
          className="primary"
          onClick={() =>
            void activeFlush
              .current()
              .then(async (ok) => {
                if (!ok) return;
                return run({
                  type: "note.save",
                  projectId,
                  noteType: planning ? "outline" : "character",
                  title: "未命名设定",
                  body: "",
                  sources: [],
                }).then((r) => setSelected(r.entityId));
              })
              .catch(() => {})
          }
        >
          新建设定
        </button>
        {notes.map((n) => (
          <button
            className={"item " + (note?.id === n.id ? "selected" : "")}
            key={n.id}
            onClick={() => void choose(n.id)}
          >
            <small>{noteNames[n.type]}</small>
            <strong>{n.title}</strong>
            {n.needsReview && <span className="badge warn">需要复核</span>}
          </button>
        ))}
      </aside>
      {note ? (
        <NoteEditor
          key={note.id}
          note={note}
          state={state}
          run={run}
          register={noteRegister}
        />
      ) : (
        <Empty title="把故事里的细节留下来">
          <p>添加人物、规则或规划，AI 建议会在审阅后由你保存。</p>
        </Empty>
      )}
    </div>
  );
}
function NoteEditor({
  note,
  state,
  run,
  register,
}: {
  note: Note;
  state: AppState;
  run: Run;
  register: Register;
}) {
  const fingerprint = sourceFingerprint(note.sources, state);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const reviewed = reviewKey === fingerprint;
  const stale = note.sources.some((s) => !sourceIsCurrent(s, state));
  const editor = useEditor(
    note,
    (n) => ({ title: n.title, body: n.body, type: n.type }),
    (n, v) => ({
      type: "note.save",
      id: n.id,
      revision: n.revision,
      projectId: n.projectId,
      noteType: v.type,
      title: v.title,
      body: v.body,
      sources: reviewed ? reviewedSources(n.sources, state) : n.sources,
    }),
    run,
    register,
  );
  const v = editor.value;
  return (
    <section className="page note-editor">
      <div className="page-heading">
        <h1>{noteNames[v.type]}</h1>
        <button
          className="danger"
          onClick={() =>
            void editor
              .flush()
              .then(async (ok) => {
                if (!ok) return;
                return run({
                  type: "note.delete",
                  id: note.id,
                  revision: (await window.novel.snapshot()).notes.find(
                    (n) => n.id === note.id,
                  )!.revision,
                });
              })
              .catch(() => {})
          }
        >
          删除设定
        </button>
      </div>
      <SaveStatus editor={editor} />
      <Field label="设定类型">
        <select
          value={v.type}
          onChange={(e) =>
            editor.edit({ ...v, type: e.target.value as NoteType })
          }
        >
          {Object.entries(noteNames).map(([id, name]) => (
            <option value={id} key={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="设定标题">
        <input
          value={v.title}
          onChange={(e) => editor.edit({ ...v, title: e.target.value })}
        />
      </Field>
      <Field label="设定正文">
        <textarea
          className="long-text"
          value={v.body}
          onChange={(e) => editor.edit({ ...v, body: e.target.value })}
          placeholder="身份、目标、关系、限制、习惯，以及需要保留的细节…"
        />
      </Field>
      {note.needsReview && (
        <div className="hint warn">
          生成依据发生变化，请阅读并修改此记录；保存后以当前来源重新复核。
        </div>
      )}
      <Sources sources={note.sources} state={state} />
      {(note.needsReview || stale) && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) =>
                setReviewKey(e.target.checked ? fingerprint : null)
              }
            />
            我已对照当前来源审核这份设定
          </label>
          <button
            disabled={!reviewed}
            onClick={() => {
              editor.edit(editor.value);
              void editor.retry();
            }}
          >
            保存复核记录
          </button>
          <p className="small muted">
            保存以当前来源建立记录；已删除来源会移除，原始引用仍保留在任务中。
          </p>
        </>
      )}
    </section>
  );
}
