import { useState } from "react";
import type { Note } from "../shared/types";
import type { Run } from "./api";
import type { Flush } from "./editing";
import { Field } from "./ui";

export function NoteHistory({
  note,
  run,
  flush,
}: {
  note: Note;
  run: Run;
  flush: Flush;
}) {
  const [selected, setSelected] = useState("");
  const versions = [...(note.history ?? [])].reverse();
  const chosen =
    versions.find((v) => String(v.revision) === selected) ?? versions[0];
  if (!chosen) return null;
  async function restore() {
    if (!(await flush())) return;
    const current = (await window.novel.snapshot()).notes.find(
      (n) => n.id === note.id,
    );
    if (!current) return;
    await run({
      type: "note.save",
      projectId: current.projectId,
      id: current.id,
      revision: current.revision,
      noteType: chosen.type,
      title: chosen.title,
      body: chosen.body,
      sources: [],
    });
  }
  return (
    <details className="note-history">
      <summary>设定历史 · {versions.length} 个版本</summary>
      <Field label="选择设定历史版本">
        <select
          value={String(chosen.revision)}
          onChange={(e) => setSelected(e.target.value)}
        >
          {versions.map((v) => (
            <option value={v.revision} key={v.revision}>
              {new Date(v.createdAt).toLocaleString("zh-CN")} · {v.title}
            </option>
          ))}
        </select>
      </Field>
      <pre>{chosen.body || "（空白）"}</pre>
      <button onClick={() => void restore().catch(() => {})}>
        恢复这份设定
      </button>
      <p className="muted">恢复后仍保留当前版本，相关规划会标记为需要复核。</p>
    </details>
  );
}
