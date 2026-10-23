import { useState } from "react";
import type { AppState, ModelProfile, ModelPurpose } from "../shared/types";
import type { Run } from "./api";
import { Empty, Field } from "./ui";
import { useManualGuard, type Register, type Flush } from "./editing";
import { getThemeChoice, setThemeChoice, type ThemeChoice } from "./theme";
const purposes = { planning: "规划", writing: "正文", checking: "检查" };
export function Profiles({
  state,
  run,
  register,
  flush,
}: {
  state: AppState;
  run: Run;
  register: Register;
  flush: Flush;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice);
  const profile = state.profiles.find((p) => p.id === selected);
  return (
    <div className="split-page">
      <aside className="item-list">
        <h2>AI 连接</h2>
        <button
          className="primary"
          onClick={() => void flush().then((ok) => ok && setSelected("new"))}
        >
          添加 AI 连接
        </button>
        {state.profiles.map((p) => (
          <button
            className={"item " + (p.id === selected ? "selected" : "")}
            key={p.id}
            onClick={() => void flush().then((ok) => ok && setSelected(p.id))}
          >
            <small>
              {purposes[p.purpose]}用 AI
            </small>
            <strong>{p.name}</strong>
            <span className={"badge " + (p.hasKey ? "ok" : "warn")}>
              {p.hasKey ? "密钥已保护" : "未配置密钥"}
            </span>
          </button>
        ))}
        <Field label="外观">
          <select
            value={theme}
            onChange={(e) => {
              const choice = e.target.value as ThemeChoice;
              setTheme(choice);
              setThemeChoice(choice);
            }}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </Field>
      </aside>
      {selected ? (
        <ProfileForm
          key={selected}
          profile={profile}
          state={state}
          run={run}
          saved={setSelected}
          register={register}
        />
      ) : (
        <Empty title="连接你的创作搭档">
          <p>
            选择你使用的 AI 服务，粘贴服务商提供的密钥即可。
            <br />
            已有连接可以直接使用；其他服务可在高级设置中填写。
            <br />
            密钥由 macOS 钥匙串保护，作品备份不含密钥。
          </p>
          <button
            onClick={() => void flush().then((ok) => ok && setSelected("new"))}
          >
            添加 AI 连接
          </button>
        </Empty>
      )}
    </div>
  );
}
function ProfileForm({
  profile,
  state,
  run,
  saved,
  register,
}: {
  profile?: ModelProfile;
  state: AppState;
  run: Run;
  saved: (id: string) => void;
  register: Register;
}) {
  const [v, set] = useState({
    name: profile?.name ?? "DeepSeek",
    baseUrl: profile?.baseUrl ?? "https://api.deepseek.com",
    model: profile?.model ?? "deepseek-flash",
    purpose: profile?.purpose ?? ("writing" as ModelPurpose),
    apiKey: "",
  });
  const preset = !profile || (profile.baseUrl === "https://api.deepseek.com" && profile.model === "deepseek-flash");
  const [service, setService] = useState(preset ? "deepseek" : "custom");
  const [advanced, setAdvanced] = useState(!preset);
  const [testId, setTestId] = useState("");
  const test = state.tasks.find((t) => t.id === testId);
  async function save() {
    const { apiKey, ...fields } = v;
    const result = await run({
      type: "profile.save",
      ...(profile ? { id: profile.id, revision: profile.revision } : {}),
      ...fields,
      ...(apiKey ? { apiKey } : {}),
    });
    const clean = { ...v, apiKey: "" };
    guard.markSaved(clean);
    set(clean);
    saved(result.entityId);
  }
  const guard = useManualGuard(v, save, register);
  return (
    <section className="page">
      <div className="eyebrow">本机配置 / 密钥保护</div>
      <h1>{profile ? "编辑 AI 连接" : "添加 AI 连接"}</h1>
      <p>连接后即可准备故事和写作。调用使用你的服务账户额度；保存连接不会发起调用，测试连接会产生少量用量。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void guard.save();
        }}
      >
        {guard.dialog}
      <fieldset className="manual-save-fields" disabled={guard.busy}>
        {guard.dirty && <p className="small warn">此配置有未保存的修改</p>}
        <Field label="服务商">
          <select value={service} onChange={e => {
            const next = e.target.value; setService(next); setAdvanced(next === "custom");
            if (next === "deepseek") set({ ...v, name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" });
          }}>
            <option value="deepseek">DeepSeek</option>
            <option value="custom">其他服务 / 自定义连接</option>
          </select>
        </Field>
        {service === "deepseek" && <p className="muted">已填写服务地址和创作模型，只需提供密钥。其他参数可在高级设置中调整。</p>}
        <details className="connection-advanced" open={advanced} onToggle={e => setAdvanced(e.currentTarget.open)}>
          <summary>高级设置</summary>
        <Field label="配置名称">
          <input
            required
            value={v.name}
            onChange={(e) => set({ ...v, name: e.target.value })}
          />
        </Field>
        <Field label="API 地址">
          <input
            required
            value={v.baseUrl}
            placeholder="https://服务商地址/v1"
            onChange={(e) => set({ ...v, baseUrl: e.target.value })}
          />
        </Field>
        <Field label="模型名称">
          <input
            required
            value={v.model}
            onChange={(e) => set({ ...v, model: e.target.value })}
          />
        </Field>
        <Field label="默认用途">
          <select
            value={v.purpose}
            onChange={(e) =>
              set({ ...v, purpose: e.target.value as ModelPurpose })
            }
          >
            {Object.entries(purposes).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        </details>
        <Field label="API 密钥">
          <input
            type="password"
            required={!profile?.hasKey && service === "deepseek"}
            autoComplete="new-password"
            value={v.apiKey}
            placeholder={
              profile?.hasKey ? "已保存；留空保留现有密钥" : "仅由本机安全存储"
            }
            onChange={(e) => set({ ...v, apiKey: e.target.value })}
          />
        </Field>
        {profile?.hasKey && <p className="success">已安全保存密钥</p>}
        <div className="toolbar">
          <button className="primary">保存连接</button>
          {profile && (
            <>
              <button
                type="button"
                onClick={() =>
                  void run({ type: "model.test", profileId: profile.id })
                    .then((r) => setTestId(r.entityId))
                    .catch(() => {})
                }
              >
                测试连接
              </button>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  void run({
                    type: "profile.delete",
                    id: profile.id,
                    revision: profile.revision,
                  })
                    .then(() => saved("new"))
                    .catch(() => {})
                }
              >
                删除连接
              </button>
            </>
          )}
        </div>
      </fieldset>
      </form>
      {test && (
        <div className="card" role="status">
          {test.status === "completed"
            ? "连接成功"
            : (test.error ?? "正在测试连接…")}
        </div>
      )}
    </section>
  );
}
