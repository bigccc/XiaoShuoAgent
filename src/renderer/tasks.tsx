import { useState, useEffect } from "react";
import type {
  AppState,
  TaskRecord,
  SourceRevision,
  NoteType,
  CheckIssue,
  Command,
} from "../shared/types";
import type { Run } from "./api";
import type { Flush } from "./editing";
import {
  Field,
  Sources,
  noteNames,
  Empty,
  sourceIsCurrent,
  reviewedSources,
  sourceFingerprint,
} from "./ui";
import { MaterialForm, type MaterialDraft } from "./materials";
export const taskNames = {
  generation: "正文生成",
  planning: "创作规划",
  check: "一致性检查",
  extraction: "素材提取",
  connection: "连接测试",
};
export const statusNames = {
  waiting: "等待中",
  running: "执行中",
  "awaiting-author": "待作者处理",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
interface Candidate {
  chapterId: string;
  text: string;
  versionId?: string;
  needsReview: boolean;
  checked: boolean;
  check?: { issues: CheckIssue[]; majorChange: boolean; reason?: string };
}
interface Result {
  suggestion?: string;
  step?: NoteType | "idea";
  sources?: SourceRevision[];
  disclosures?: string[];
  candidates?: Candidate[];
  pauseReason?: string;
  materials?: MaterialDraft[];
  connection?: boolean;
  check?: { issues: CheckIssue[]; majorChange: boolean; reason?: string };
}
export function AiPanel({
  state,
  projectId,
  chapterId,
  run,
  flush,
  showTasks,
  showProfiles,
}: {
  state: AppState;
  projectId: string;
  chapterId?: string;
  run: Run;
  flush: Flush;
  showTasks: () => void;
  showProfiles: () => void;
}) {
  const [profile, setProfile] = useState(""),
    [planning, setPlanning] = useState(""),
    [checking, setChecking] = useState(""),
    [step, setStep] = useState<NoteType | "idea">("idea"),
    [budget, setBudget] = useState(20000),
    [instruction, setInstruction] = useState(""),
    [drafts, setDrafts] = useState<string[]>([]),
    [materials, setMaterials] = useState<string[]>([]),
    [notes, setNotes] = useState<string[]>([]),
    [allNotes, setAllNotes] = useState(true),
    [auto, setAuto] = useState(false),
    [batch, setBatch] = useState<string[]>([]),
    [authorize, setAuthorize] = useState(false),
    [source, setSource] = useState(""),
    [sourceText, setSourceText] = useState(""),
    [file, setFile] = useState(false),
    [advanced, setAdvanced] = useState(false);
  const writing =
    state.profiles.find((p) => p.id === profile) ??
    state.profiles.find((p) => p.purpose === "writing") ??
    state.profiles[0];
  const planningProfile =
    state.profiles.find((p) => p.id === planning) ??
    state.profiles.find((p) => p.purpose === "planning") ??
    writing;
  const checkingProfile =
    state.profiles.find((p) => p.id === checking) ??
    state.profiles.find((p) => p.purpose === "checking") ??
    writing;
  const chapters = state.chapters
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => a.ordinal - b.ordinal);
  async function start(kind: "plan" | "chapter" | "check" | "extract") {
    if (!writing) {
      showProfiles();
      return;
    }
    if (!(await flush())) return;
    const chosen =
      kind === "plan" || kind === "extract"
        ? planningProfile
        : kind === "check"
          ? checkingProfile
          : writing;
    const base = {
      projectId,
      profileId: chosen.id,
      tokenBudget: budget,
      instruction,
      includeDraftIds: drafts,
      materialIds: materials,
      allowAutoMaterials: auto,
      ...(!allNotes ? { noteIds: notes } : {}),
    };
    let command: Command;
    if (kind === "plan") command = { type: "ai.plan", step, ...base };
    else if (kind === "chapter")
      command = {
        type: "ai.chapter",
        chapterIds: batch.length
          ? chapters.filter((c) => batch.includes(c.id)).map((c) => c.id)
          : chapterId
            ? [chapterId]
            : chapters[0]
              ? [chapters[0].id]
              : [],
        authorizeBatch: authorize,
        ...(checkingProfile ? { checkingProfileId: checkingProfile.id } : {}),
        ...base,
      };
    else if (kind === "check") command = { type: "ai.check", ...base };
    else
      command = {
        type: "ai.extract",
        source,
        ...(!file ? { sourceText } : {}),
        ...base,
      };
    await run(command);
    showTasks();
  }
  function toggle(arr: string[], id: string, set: (v: string[]) => void) {
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  }
  return (
    <aside className="ai-panel">
      <div className="eyebrow">AI 创作助手</div>
      <h2>把下一步交给灵感</h2>
      <p>建议与候选单独保存，由你决定采用。</p>
      {!state.profiles.length ? (
        <div className="hint">
          <strong>还没有配置模型</strong>
          <p>本机编辑随时可用。配置 API 后可以规划、生成与检查。</p>
          <button onClick={showProfiles}>前往模型设置</button>
        </div>
      ) : (
        <>
          <Field label="本次模型">
            <select
              value={writing?.id ?? ""}
              onChange={(e) => setProfile(e.target.value)}
            >
              {state.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </Field>
          <Field label="规划使用模型">
            <select
              value={planningProfile?.id ?? ""}
              onChange={(e) => setPlanning(e.target.value)}
            >
              {state.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="检查使用模型">
            <select
              value={checkingProfile?.id ?? ""}
              onChange={(e) => setChecking(e.target.value)}
            >
              {state.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="规划步骤">
            <select
              value={step}
              onChange={(e) => setStep(e.target.value as typeof step)}
            >
              <option value="idea">创意与看点</option>
              {Object.entries(noteNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="本次要求">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="想保留什么、调整哪里？"
            />
          </Field>
          <Field label="Token 预算上限">
            <input
              type="number"
              min="100"
              max="10000000"
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
          </Field>
          <p className="muted small">
            包含生成与检查调用。缺少服务商用量时显示估算；不是金额保证。
          </p>
          <div className="ai-actions">
            <button onClick={() => void start("plan").catch(() => {})}>
              生成规划建议
            </button>
            <button
              className="primary"
              onClick={() => void start("chapter").catch(() => {})}
            >
              生成选中章节
            </button>
            <button onClick={() => void start("check").catch(() => {})}>
              检查已确认正文
            </button>
          </div>
          <button
            className="text-button"
            onClick={() => setAdvanced(!advanced)}
          >
            {advanced ? "收起" : "展开"}上下文与批量设置 ↓
          </button>
          {advanced && (
            <div className="advanced">
              <h3>连续生成 3—5 章</h3>
              {chapters.map((c) => (
                <label className="check" key={c.id}>
                  <input
                    type="checkbox"
                    checked={batch.includes(c.id)}
                    onChange={() => toggle(batch, c.id, setBatch)}
                  />
                  {c.ordinal}. {c.title}
                </label>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={authorize}
                  onChange={(e) => setAuthorize(e.target.checked)}
                />
                我授权本次连续生成 3—5 章
              </label>
              <p className="small muted">
                须选择连续章节；未选时生成当前章，候选不会自动确认。
              </p>
              <h3>明确纳入前文草稿</h3>
              {chapters
                .filter((c) => c.status === "draft")
                .map((c) => (
                  <label className="check" key={c.id}>
                    <input
                      type="checkbox"
                      checked={drafts.includes(c.id)}
                      onChange={() => toggle(drafts, c.id, setDrafts)}
                    />
                    {c.ordinal}. {c.title}
                  </label>
                ))}
              <h3>设定与素材</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={allNotes}
                  onChange={(e) => setAllNotes(e.target.checked)}
                />
                使用所有有效设定
              </label>
              {!allNotes &&
                state.notes
                  .filter((n) => n.projectId === projectId)
                  .map((n) => (
                    <label className="check" key={n.id}>
                      <input
                        type="checkbox"
                        checked={notes.includes(n.id)}
                        onChange={() => toggle(notes, n.id, setNotes)}
                      />
                      {n.title}
                    </label>
                  ))}
              {state.materials
                .filter((m) => m.approved)
                .map((m) => (
                  <label className="check" key={m.id}>
                    <input
                      type="checkbox"
                      checked={materials.includes(m.id)}
                      onChange={() => toggle(materials, m.id, setMaterials)}
                    />
                    {m.title}
                  </label>
                ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => setAuto(e.target.checked)}
                />
                授权 AI 自动选用已审核素材
              </label>
              <h3>素材提取</h3>
              <Field label="提取来源备注">
                <input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={file}
                  onChange={(e) => setFile(e.target.checked)}
                />
                从 TXT／DOCX 文件提取
              </label>
              {!file && (
                <Field label="待提取原文">
                  <textarea
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                  />
                </Field>
              )}
              <button onClick={() => void start("extract").catch(() => {})}>
                提取素材候选
              </button>
            </div>
          )}
        </>
      )}
      <div className="recent-tasks">
        <h3>最近任务</h3>
        {state.tasks
          .filter((t) => t.projectId === projectId)
          .slice(-3)
          .reverse()
          .map((t) => (
            <button key={t.id} className="item" onClick={showTasks}>
              <strong>{taskNames[t.kind]}</strong>
              <small>
                {statusNames[t.status]} · {t.calls} 次调用
              </small>
            </button>
          ))}
      </div>
    </aside>
  );
}
export function Tasks({
  state,
  projectId,
  run,
  flush,
}: {
  state: AppState;
  projectId?: string;
  run: Run;
  flush: Flush;
}) {
  const tasks = state.tasks
    .filter((t) => !projectId || t.projectId === projectId)
    .slice()
    .reverse();
  const [id, setId] = useState("");
  const task = tasks.find((t) => t.id === id) ?? tasks[0];
  useEffect(() => {
    if (tasks[0]) setId(tasks[0].id);
  }, [tasks[0]?.id]);
  return (
    <div className="split-page">
      <aside className="item-list">
        <h2>任务与审阅</h2>
        {tasks.map((t) => (
          <button
            className={"item " + (task?.id === t.id ? "selected" : "")}
            key={t.id}
            onClick={() => setId(t.id)}
          >
            <strong>{taskNames[t.kind]}</strong>
            <small>{new Date(t.createdAt).toLocaleString("zh-CN")}</small>
            <span className="badge">{statusNames[t.status]}</span>
          </button>
        ))}
      </aside>
      {task ? (
        <TaskDetail
          key={task.id}
          task={task}
          state={state}
          run={run}
          flush={flush}
        />
      ) : (
        <Empty title="你的创作任务会保存在这里">
          <p>进度、片段、结果、来源和失败原因都有记录。</p>
        </Empty>
      )}
    </div>
  );
}
function TaskDetail({
  task,
  state,
  run,
  flush,
}: {
  task: TaskRecord;
  state: AppState;
  run: Run;
  flush: Flush;
}) {
  const r = (task.result ?? {}) as unknown as Result;
  return (
    <section className="page task-detail">
      <div className="page-heading">
        <div>
          <div className="eyebrow">任务记录</div>
          <h1>{taskNames[task.kind]}</h1>
        </div>
        <span className="badge">{statusNames[task.status]}</span>
      </div>
      <div className="task-stats">
        <span>{task.calls} 次调用</span>
        <span>
          Token：{task.usage?.totalTokens ?? "未报告"}
          {task.usage?.estimated ? "（估算／预算预留）" : "（服务商报告）"}
        </span>
      </div>
      {task.error && (
        <div className="error" role="alert">
          {task.error}
        </div>
      )}
      {r.pauseReason && <div className="hint warn">{r.pauseReason}</div>}
      <div className="toolbar">
        {["running", "waiting", "awaiting-author"].includes(task.status) && (
          <button
            onClick={() =>
              void run({ type: "task.cancel", id: task.id }).catch(() => {})
            }
          >
            取消任务
          </button>
        )}
        {["failed", "cancelled", "interrupted", "awaiting-author"].includes(
          task.status,
        ) && (
          <>
            <button
              onClick={() =>
                void run({
                  type: "task.resume",
                  id: task.id,
                  mode: "continue",
                }).catch(() => {})
              }
            >
              继续任务
            </button>
            <button
              onClick={() =>
                void run({
                  type: "task.resume",
                  id: task.id,
                  mode: "rewrite",
                }).catch(() => {})
              }
            >
              重写未完成部分
            </button>
          </>
        )}
      </div>
      {r.connection && <div className="success">连接成功</div>}
      {task.partial && (
        <div className="card">
          <h2>已保留的片段</h2>
          <pre>{task.partial}</pre>
        </div>
      )}
      {r.suggestion && (
        <PlanningResult task={task} result={r} state={state} run={run} />
      )}
      <div className="candidates">
        {r.candidates?.map((c, i) => (
          <CandidateResult
            key={c.versionId ?? i}
            candidate={c}
            task={task}
            state={state}
            run={run}
            flush={flush}
          />
        ))}
      </div>
      {r.materials?.map((m, i) => (
        <div className="card" key={i}>
          <h2>提取候选 · 请先阅读审核</h2>
          <MaterialForm draft={m} run={run} />
        </div>
      ))}
      {r.check && (
        <>
          <h2>六类一致性检查</h2>
          <p className="muted">
            人物、时间、地点、规则、知情与伏笔。AI 无法保证发现所有冲突。
          </p>
          {r.check.issues.length ? (
            r.check.issues.map((issue, i) => (
              <div className="card" key={i}>
                <h3>{issue.reason}</h3>
                <Evidence evidence={issue.evidence} state={state} />
              </div>
            ))
          ) : (
            <div className="hint">
              本次未发现有原文证据的冲突。仍需作者通读。
            </div>
          )}
        </>
      )}
      <h3>任务来源</h3>
      <Sources sources={r.sources ?? task.sourceRevisions} state={state} />
      {!!r.disclosures?.length && (
        <div className="hint">
          <strong>上下文取舍与截断</strong>
          {r.disclosures.map((d, i) => (
            <p key={i}>{d}</p>
          ))}
        </div>
      )}
    </section>
  );
}
function PlanningResult({
  task,
  result,
  state,
  run,
}: {
  task: TaskRecord;
  result: Result;
  state: AppState;
  run: Run;
}) {
  const [body, setBody] = useState(result.suggestion ?? ""),
    [title, setTitle] = useState("AI 规划建议"),
    [type, setType] = useState<NoteType>(
      result.step === "idea" ? "storyline" : (result.step ?? "outline"),
    ),
    [done, setDone] = useState(false);
  const sources = result.sources ?? task.sourceRevisions;
  const stale = sources.some((s) => !sourceIsCurrent(s, state));
  const fingerprint = sourceFingerprint(sources, state);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const reviewed = reviewKey === fingerprint;
  const acceptedSources =
    stale && reviewed ? reviewedSources(sources, state) : sources;
  return (
    <div className="card">
      <h2>规划建议 · 由作者审阅后保存</h2>
      <Field label="建议标题">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="保存为设定类型">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as NoteType)}
        >
          {Object.entries(noteNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="可编辑的规划建议">
        <textarea
          className="long-text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <Sources sources={sources} state={state} />
      {stale && (
        <label className="check">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) =>
              setReviewKey(e.target.checked ? fingerprint : null)
            }
          />
          我已对照当前来源审核这份规划
        </label>
      )}
      <button
        className="primary"
        disabled={done || (stale && !reviewed)}
        onClick={() =>
          void run({
            type: "note.save",
            projectId: task.projectId,
            noteType: type,
            title,
            body,
            sources: acceptedSources,
          })
            .then(() => setDone(true))
            .catch(() => {})
        }
      >
        {done ? "已保存为设定" : "采纳为新设定"}
      </button>
      {result.step === "idea" && (
        <button
          disabled={stale && !reviewed}
          onClick={() => {
            const p = state.projects.find((p) => p.id === task.projectId);
            if (p)
              void run({
                type: "project.update",
                id: p.id,
                revision: p.revision,
                patch: { background: body },
              }).catch(() => {});
          }}
        >
          采用为作品背景
        </button>
      )}
    </div>
  );
}
function CandidateResult({
  candidate: c,
  task,
  state,
  run,
  flush,
}: {
  candidate: Candidate;
  task: TaskRecord;
  state: AppState;
  run: Run;
  flush: Flush;
}) {
  const chapter = state.chapters.find((x) => x.id === c.chapterId),
    [reviewKey, setReviewKey] = useState<string | null>(null),
    [done, setDone] = useState(false);
  const fingerprint =
    sourceFingerprint(task.sourceRevisions, state) +
    "|target:" +
    chapter?.revision;
  const reviewed = reviewKey === fingerprint;
  const stale =
    c.needsReview ||
    task.sourceRevisions.some((s) => {
      const list =
        s.kind === "project"
          ? state.projects
          : s.kind === "note"
            ? state.notes
            : state.chapters;
      return list.find((x) => x.id === s.id)?.revision !== s.revision;
    });
  async function adopt() {
    if (!(await flush()) || !chapter) return;
    const current = (await window.novel.snapshot()).chapters.find(
      (x) => x.id === chapter.id,
    )!;
    await run(
      c.versionId
        ? {
            type: "chapter.restore",
            id: chapter.id,
            revision: current.revision,
            versionId: c.versionId,
          }
        : {
            type: "chapter.save",
            id: chapter.id,
            revision: current.revision,
            content: c.text,
          },
    );
    setDone(true);
  }
  return (
    <article className="card">
      <h2>{chapter?.title ?? "章节候选"}</h2>
      <div className="toolbar">
        <span className="badge">
          {c.checked ? "已完成本次检查" : "尚未完成检查"}
        </span>
        {stale && <span className="badge warn">依据已变化 · 需要复核</span>}
      </div>
      <pre>{c.text}</pre>
      {c.check?.reason && <p className="warn">{c.check.reason}</p>}
      {c.check?.issues.map((issue, i) => (
        <div className="hint warn" key={i}>
          <strong>{issue.reason}</strong>
          <Evidence evidence={issue.evidence} state={state} />
        </div>
      ))}
      {stale && (
        <label className="check">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) =>
              setReviewKey(e.target.checked ? fingerprint : null)
            }
          />
          我已对照变化后的来源复核此候选
        </label>
      )}
      <button
        className="primary"
        disabled={done || !chapter || (stale && !reviewed)}
        onClick={() => void adopt().catch(() => {})}
      >
        {done ? "已采用为草稿" : "采用为草稿"}
      </button>
      <p className="small muted">
        采用形成新草稿并保留旧版；不会自动确认正文。
      </p>
    </article>
  );
}
export function Evidence({
  evidence,
  state,
}: {
  evidence: CheckIssue["evidence"];
  state: AppState;
}) {
  return (
    <>
      {evidence.map((e, i) => (
        <blockquote key={i}>
          {e.quote}
          <Sources sources={[e.source]} state={state} />
          {e.candidateVersionId && (
            <details>
              <summary>查看 AI 候选版本原文</summary>
              <pre>
                {state.versions.find((v) => v.id === e.candidateVersionId)
                  ?.content ?? "此候选保留在任务结果中"}
              </pre>
            </details>
          )}
        </blockquote>
      ))}
    </>
  );
}
export function Issues({
  state,
  projectId,
  run,
}: {
  state: AppState;
  projectId: string;
  run: Run;
}) {
  const [filter, setFilter] = useState("open"),
    issues = state.issues.filter(
      (x) => x.projectId === projectId && x.status === filter,
    );
  return (
    <section className="page">
      <div className="eyebrow">作者复核 / 六类证据</div>
      <h1>一致性检查</h1>
      <p>覆盖人物、时间、地点、世界规则、知情范围与伏笔。结果需要人工判断。</p>
      <div className="toolbar">
        {[
          ["open", "待处理"],
          ["resolved", "已处理"],
          ["ignored", "已忽略"],
        ].map(([id, name]) => (
          <button
            key={id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id)}
          >
            {name}
          </button>
        ))}
      </div>
      {issues.length ? (
        issues.map((issue) => (
          <article className="card" key={issue.id}>
            <div className="eyebrow">{noteNames[issue.type]}</div>
            <h2>{issue.reason}</h2>
            <Evidence evidence={issue.evidence} state={state} />
            {issue.status === "open" && (
              <div className="toolbar">
                <button
                  onClick={() =>
                    void run({
                      type: "issue.resolve",
                      id: issue.id,
                      revision: issue.revision,
                      status: "resolved",
                    }).catch(() => {})
                  }
                >
                  已修改，标记处理
                </button>
                <button
                  onClick={() =>
                    void run({
                      type: "issue.resolve",
                      id: issue.id,
                      revision: issue.revision,
                      status: "ignored",
                    }).catch(() => {})
                  }
                >
                  忽略此问题
                </button>
              </div>
            )}
          </article>
        ))
      ) : (
        <Empty title="这里没有这类问题记录">
          <p>在右侧发起检查，结果会保留原文与来源。</p>
        </Empty>
      )}
    </section>
  );
}
