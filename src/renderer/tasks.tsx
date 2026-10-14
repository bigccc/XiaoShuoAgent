import { useState, useEffect } from "react";
import { validateTask } from "../shared/validation";
import { countProse, proseRange } from "../shared/prose";
import type {
  AppState,
  TaskRecord,
  SourceRevision,
  NoteType,
  CheckIssue,
  Command,
} from "../shared/types";
import type { Run } from "./api";
import { useManualGuard, type Flush, type Register } from "./editing";
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
  checkCacheHits?:number;
  checkCacheMisses?:number;
  suggestion?: string;
  step?: NoteType | "idea";
  sources?: SourceRevision[];
  disclosures?: string[];
  candidates?: Candidate[];
  pauseReason?: string;
  materials?: MaterialDraft[];
  connection?: boolean;
  check?: { issues: CheckIssue[]; majorChange: boolean; reason?: string };
  checkProgress?: {
    chapterId?: string;
    completed: number;
    total: number;
    checked: { issues: CheckIssue[]; majorChange: boolean; reason?: string };
  };
}
export function AiPanel({
  state,
  projectId,
  chapterId,
  writingView,
  run,
  flush,
  showTasks,
  showProfiles,
}: {
  state: AppState;
  projectId: string;
  chapterId?: string;
  writingView: boolean;
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
    [words, setWords] = useState<number | undefined>(),
    [planningWords, setPlanningWords] = useState(10000),
    [planningTokens, setPlanningTokens] = useState(8000),
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
  const chapterWords =
    words ??
    state.projects.find((p) => p.id === projectId)?.chapterWords ??
    3000;
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
    if (kind === "plan") command = { type: "ai.plan", step, planningMaxWords: planningWords, maxOutputTokens: planningTokens, ...base };
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
        chapterWords,
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
          <strong>还没有连接 AI</strong>
          <p>本机编辑随时可用。连接 AI 后可以准备故事、写作和检查。</p>
          <button onClick={showProfiles}>连接 AI</button>
        </div>
      ) : (
        <>
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
          <div className="form-grid">
            {writingView ? (
            <Field label="本次章节字数">
              <input
                type="number"
                min="1"
                max="16000"
                value={chapterWords}
                onChange={(e) => setWords(Number(e.target.value))}
              />
            </Field>
            ) : (
              <Field label="规划建议字数上限">
                <input type="number" min="1" max="300000" value={planningWords} onChange={(e) => setPlanningWords(Number(e.target.value))} />
              </Field>
            )}
          </div>
          <details className="ai-advanced"><summary>高级设置</summary>
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
            <Field label="任务总 Token 预算">
              <input
                type="number"
                min="100"
                max="10000000"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </Field>
          {!writingView && (
            <>
              <Field label="规划单次输出上限（Token）">
                <input type="number" min="1" max="32000" value={planningTokens} onChange={(e) => setPlanningTokens(Number(e.target.value))} />
              </Field>
              <p className="muted small">规划字数是累计上限（含标点、不含空白），不是要求写满，也不是小说总字数。单次输出受模型限制；截断后可在任务中继续补全。</p>
            </>
          )}
          <p className="muted small">
            总预算包含输入、输出、检查、重试与续写；提高总预算不会提高单次输出上限。缺少服务商用量时显示估算；不是金额保证。
          </p>
          </details>
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
  register,
}: {
  state: AppState;
  projectId?: string;
  run: Run;
  flush: Flush;
  register: Register;
}) {
  const tasks = state.tasks
    .filter((t) => !projectId || t.projectId === projectId)
    .slice()
    .reverse();
  const [id, setId] = useState(() => tasks[0]?.id ?? "");
  const task = tasks.find((t) => t.id === id) ?? tasks[0];
  useEffect(() => {
    if (!tasks[0]) return;
    if (!id) {
      setId(tasks[0].id);
      return;
    }
    if (id === tasks[0].id) return;
    let cancelled = false;
    void flush().then((ok) => {
      if (ok && !cancelled) setId(tasks[0].id);
    });
    return () => {
      cancelled = true;
    };
  }, [tasks[0]?.id, flush]);
  return (
    <div className="split-page">
      <aside className="item-list">
        <h2>任务与审阅</h2>
        {tasks.map((t) => (
          <button
            className={"item " + (task?.id === t.id ? "selected" : "")}
            key={t.id}
            onClick={() => {
              if (task?.id !== t.id)
                void flush().then((ok) => {
                  if (ok) setId(t.id);
                });
            }}
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
          register={register}
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
  register,
}: {
  task: TaskRecord;
  state: AppState;
  run: Run;
  flush: Flush;
  register: Register;
}) {
  try {
    validateTask(task);
  } catch {
    return (
      <section className="page task-detail">
        <h1>任务记录</h1>
        <div className="error" role="alert">
          任务数据格式异常，已保留原始记录。请从有效备份恢复或重新创建任务。
        </div>
        {typeof task.partial === "string" && task.partial && (
          <div className="card">
            <h2>已保留的片段</h2>
            <pre>{task.partial}</pre>
          </div>
        )}
      </section>
    );
  }
  const r = task.result as unknown as Result;
  return (
    <section className="page task-detail">
      <div className="page-heading">
        <div>
          <div className="eyebrow">任务记录</div>
          <h1>{taskNames[task.kind]}</h1>
        </div>
        <span className="badge">{statusNames[task.status]}</span>
      </div>
      <details className="task-stats"><summary>技术详情</summary>
        <span>{task.calls} 次调用</span>
        <span>
          Token：{task.usage?.totalTokens ?? "未报告"}
          {task.usage?.estimated ? "（估算／预算预留）" : "（服务商报告）"}
        </span>
      </details>
      {task.error && (
        <div className="error" role="alert">
          {task.error}
        </div>
      )}
      {r.pauseReason && <div className="hint warn">{r.pauseReason}</div>}
      {(r.checkCacheHits!==undefined||r.checkCacheMisses!==undefined)&&<p className="hint">复用已验证窗口 {r.checkCacheHits??0} 段；本次新检查 {r.checkCacheMisses??0} 段。</p>}
      {r.checkProgress && (
        <div className="hint" role="status">
          <strong>检查覆盖：{r.checkProgress.completed} / {r.checkProgress.total} 段</strong>
          <p>{r.checkProgress.chapterId ? "当前候选及其来源" : "所选来源快照"}逐段初检并复核，相邻段保留重叠。
            {r.checkProgress.completed < r.checkProgress.total
              ? " 检查尚未完成，未覆盖部分不能视为通过；已完成段的结果已保存。"
              : " 所有分段已检查；远距离跨段矛盾仍需作者通读核对。"}</p>
          {r.checkProgress.completed < r.checkProgress.total && r.checkProgress.checked.issues.map((issue, i) => (
            <div key={i}>
              <strong>{issue.reason}</strong>
              <Evidence evidence={issue.evidence} state={state} />
            </div>
          ))}
        </div>
      )}
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
        ) && !(task.kind === "planning" && task.status === "awaiting-author" && r.suggestion !== undefined) && (
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
        <PlanningResult
          task={task}
          result={r}
          state={state}
          run={run}
          register={register}
        />
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
          <MaterialForm draft={m} run={run} register={register} />
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
          <strong>上下文、字数与检查记录</strong>
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
  register,
}: {
  task: TaskRecord;
  result: Result;
  state: AppState;
  run: Run;
  register: Register;
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
  const authorDraft = { body, title, type };
  async function adopt() {
    if (stale && !reviewed) throw new Error("请先对照当前来源复核");
    await run({
      type: "note.save",
      projectId: task.projectId,
      noteType: type,
      title,
      body,
      sources: acceptedSources,
    });
    guard.markSaved(authorDraft);
    setDone(true);
  }
  const guard = useManualGuard(authorDraft, adopt, register, {
    saveLabel: "采纳为新设定并离开",
    description: "当前审阅修改尚未采纳。选择采纳为新设定，或返回继续检查。",
    canSave: !stale || reviewed,
  });
  return (
    <div className="card">
      <h2>规划建议 · 由作者审阅后保存</h2>
      {guard.dialog}
      <Field label="建议标题">
        <input
          disabled={done}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="保存为设定类型">
        <select
          disabled={done}
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
          disabled={done}
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
        onClick={() => void adopt().catch(() => {})}
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
              })
                .then(() => guard.markSaved(authorDraft))
                .catch(() => {});
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
  const target = (
    task.requestSnapshot as unknown as { command: { chapterWords?: number } }
  ).command.chapterWords;
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
      {target && (
        <p className="small muted">
          正文 {countProse(c.text)} 字 · 本次目标 {target} 字（
          {proseRange(target).join("—")} 字）
        </p>
      )}
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
