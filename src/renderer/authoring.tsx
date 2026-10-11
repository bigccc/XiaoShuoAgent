import { useState } from "react";
import type {
  AppState,
  AuthoringDocument,
  Command,
  PlanningStage,
  Project,
} from "../shared/types";
import { stageDescriptions, stageNames } from "../shared/authoring";
import { fieldLabels } from "../shared/sync";
import { useEditor, type Register } from "./editing";
import type { Run } from "./api";
import { Field, SaveStatus } from "./ui";

export function StageEditor({
  project,
  state,
  profileId,
  stage,
  document,
  run,
  register,
}: {
  project: Project;
  state: AppState;
  profileId?: string;
  stage: PlanningStage;
  document?: AuthoringDocument;
  run: Run;
  register: Register;
}) {
  const editor = useEditor(
    project,
    () => ({ content: document?.content ?? "" }),
    (p, v) => ({
      type: "authoring.save",
      id: p.id,
      revision: p.revision,
      stage,
      content: v.content,
    }),
    run,
    register,
  );
  const [chosen, setChosen] = useState("");
  const history = [...(document?.history ?? [])].reverse();
  const previous =
    history.find((h) => String(h.revision) === chosen) ?? history[0];
  return (
    <section className="stage-editor">
      <div className="stage-document-heading">
        <h2>
          {stage === "overview"
            ? "故事概要"
            : stage === "settings"
              ? "必要设定"
              : "故事大纲"}
        </h2>
        <span className="badge">
          {document?.sync?.status === "conflict"
            ? "待选择"
            : document?.needsReview
            ? "待同步"
            : document?.approved
              ? "已确认"
              : document?.content.trim()
                ? "待确认"
                : "待准备"}
        </span>
      </div>
      <p>{stageDescriptions[stage]}</p>
      <SaveStatus editor={editor} />
      <StageSyncPanel
        key={document?.sync?.jobId ?? state.syncJobs.filter(j => j.projectId === project.id && j.stage === stage).at(-1)?.id ?? stage}
        project={project}
        state={state}
        stage={stage}
        document={document}
        profileId={profileId}
        run={run}
        flush={editor.flush}
        draftChanged={editor.value.content !== (document?.content ?? "")}
      />
      {document?.needsReview && (
        <div className="hint warn">
          上游内容有变化。可以在对话中让 AI 同步相关成果，再集中确认。
        </div>
      )}
      <Field label={`${stageNames[stage]}成果`}>
        <textarea
          className="stage-content"
          value={editor.value.content}
          maxLength={30000}
          onChange={(e) => editor.edit({ content: e.target.value })}
          placeholder={`和 AI 聊聊，它会在这里整理${stageNames[stage]}。你也可以直接写下自己的想法。`}
        />
      </Field>
      <p className="stage-editor-hint">
        确认方向后，在左侧回复「继续」。编辑会自动保存，停笔 5 秒后同步到辅助工具。
      </p>
      {previous && (
        <details className="stage-history">
          <summary>成果历史</summary>
          <Field label="选择成果历史版本">
            <select
              value={String(previous.revision)}
              onChange={(e) => setChosen(e.target.value)}
            >
              {history.map((h) => (
                <option key={h.revision} value={h.revision}>
                  {new Date(h.createdAt).toLocaleString("zh-CN")} · 第{" "}
                  {h.revision} 版
                </option>
              ))}
            </select>
          </Field>
          <pre>{previous.content || "（空白）"}</pre>
          <button
            onClick={() => {
              void editor.flush().then(async (ok) => {
                if (!ok) return;
                const current = (await window.novel.snapshot()).projects.find(p => p.id === project.id)!;
                await run({ type: "authoring.restore", projectId: project.id, stage, revision: current.revision, historyRevision: previous.revision });
              }).catch(() => {});
            }}
          >
            恢复这份成果
          </button>
        </details>
      )}
    </section>
  );
}


function StageSyncPanel({ project, state, stage, document, profileId, run, flush, draftChanged }: {
  project: Project; state: AppState; stage: PlanningStage; document?: AuthoringDocument;
  profileId?: string; run: Run; flush: () => Promise<boolean>; draftChanged: boolean;
}) {
  const sync = document?.sync;
  const job = state.syncJobs.find(j => j.id === sync?.jobId) ?? state.syncJobs.filter(j => j.projectId === project.id && j.stage === stage).at(-1);
  const status = draftChanged && sync?.status !== "conflict" ? "pending" : sync?.status ?? (job?.status === "conflict" ? "conflict" : job?.status === "failed" || job?.status === "interrupted" ? "failed" : undefined);
  const [links, setLinks] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const conflict = status === "conflict";
  const labels = { synced: "已同步到辅助工具", pending: "等待同步", running: "正在同步", failed: "同步未完成", conflict: "需要选择保留内容" };
  const conflicts = job?.conflicts ?? [];
  const ambiguous = conflicts.filter(c => c.noteIds.length > 1 && job?.proposal?.blocks.some((b, i) => (b.id ?? `block-${i}`) === c.blockId && b.kind === "note"));
  const records = state.notes.filter(n => n.projectId === project.id && (conflicts.some(c => c.noteIds.includes(n.id)) || sync?.bindings.some(b => b.noteId === n.id)));
  const execute = async (command: Command) => {
    setBusy(true);
    try { if (await flush()) await run(command); } finally { setBusy(false); }
  };
  const resolve = (resolution: "draft" | "records") => job && execute({ type: "authoring.resolveSync", id: job.id, resolution, ...(resolution === "draft" ? { links } : {}) });
  return <section className="stage-sync" aria-label="阶段同步">
    <div className="stage-sync-heading">
      <span role="status" aria-label="阶段同步状态">{status ? labels[status] : "尚未同步"}</span>
      <div className="toolbar">
        {status === "running" && job ? <button disabled={busy} onClick={() => void execute({ type: "authoring.cancelSync", id: job.id }).catch(() => {})}>停止同步</button> :
          <button disabled={busy || conflict || (!document && !draftChanged)} onClick={() => void execute({ type: "authoring.sync", projectId: project.id, stage, ...(profileId ? { profileId } : {}) }).catch(() => {})}>立即同步</button>}
        {job && ["failed", "cancelled", "interrupted"].includes(job.status) && !conflict && <button disabled={busy} onClick={() => void execute({ type: "authoring.retrySync", id: job.id }).catch(() => {})}>重试同步</button>}
      </div>
    </div>
    {(sync?.error || job?.error) && <p className="small warn">{sync?.error || job?.error}。阶段草稿保留在本机。</p>}
    {!!job?.summary.length && <details><summary>本次同步结果</summary><ul>{job.summary.map((s, i) => <li key={i}>{s}</li>)}</ul></details>}
    {conflict && job && <div className="stage-sync-conflict">
      <p>阶段草稿和辅助资料都已保留。选好后再继续创作。</p>
      {conflicts.map(c => <p key={c.blockId}><strong>{c.title}</strong>：{c.reason}</p>)}
      <details open aria-label="保留的辅助资料"><summary>查看辅助资料当前内容</summary>
        {!!sync?.bindings.some(b => b.kind === "field") && <pre>{sync.bindings.filter(b => b.kind === "field").map(b => `${fieldLabels[b.field!]}：${project[b.field!]}`).join("\n\n")}</pre>}
        {records.map(n => <article key={n.id}><strong>{n.title}</strong><small> · {n.id}</small><pre>{n.body}</pre></article>)}
        {!records.length && !sync?.bindings.length && <p>辅助资料尚未建立关联。</p>}
      </details>
      {ambiguous.map(c => <Field key={c.blockId} label={`关联记录：${c.title}`}><select value={links[c.blockId] === null ? "new" : links[c.blockId] ?? ""} onChange={e => setLinks({ ...links, [c.blockId]: e.target.value === "new" ? null : e.target.value })}>
        <option value="" disabled>请选择现有记录或新建</option>
        {c.noteIds.map(id => { const n = state.notes.find(n => n.id === id); return <option key={id} value={id}>{n?.title ?? "现有记录"} · {id}</option>; })}
        <option value="new">新建独立记录</option>
      </select></Field>)}
      <div className="toolbar">
        <button disabled={busy || ambiguous.some(c => !Object.prototype.hasOwnProperty.call(links, c.blockId))} onClick={() => void resolve("draft")?.catch(() => {})}>采用阶段草稿</button>
        <button disabled={busy} onClick={() => void resolve("records")?.catch(() => {})}>采用辅助资料</button>
      </div>
    </div>}
  </section>;
}
