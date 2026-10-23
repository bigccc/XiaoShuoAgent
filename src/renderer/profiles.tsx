import { useState } from "react";
import type { AppState, ModelProfile, ModelPurpose } from "../shared/types";
import { invalid, validateModelPricing } from "../shared/validation";
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
            {!p.pricing && <span className="badge warn">待填写价格</span>}
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
            填写模型单价后即可估算花费；其他服务可在高级设置中填写。
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
    inputPrice: profile?.pricing?.input.toString() ?? "",
    outputPrice: profile?.pricing?.output.toString() ?? "",
    cachedInputPrice: profile?.pricing?.cachedInput?.toString() ?? "",
  });
  const preset = !profile || (profile.baseUrl === "https://api.deepseek.com" && profile.model === "deepseek-flash");
  const [service, setService] = useState(preset ? "deepseek" : "custom");
  const [advanced, setAdvanced] = useState(!preset);
  const [testId, setTestId] = useState("");
  const test = state.tasks.find((t) => t.id === testId);
  async function save() {
    const { apiKey, inputPrice, outputPrice, cachedInputPrice, ...fields } = v;
    const hasPrice = [inputPrice, outputPrice, cachedInputPrice].some((price) => price.trim() !== "");
    if (!hasPrice && profile?.pricing) invalid("已配置的模型价格不能为空；免费模型请明确填写 0");
    const pricing = hasPrice ? {
      currency: "CNY" as const,
      input: inputPrice.trim() ? Number(inputPrice) : Number.NaN,
      output: outputPrice.trim() ? Number(outputPrice) : Number.NaN,
      ...(cachedInputPrice.trim() ? { cachedInput: Number(cachedInputPrice) } : {}),
    } : undefined;
    if (pricing) validateModelPricing(pricing);
    const result = await run({
      type: "profile.save",
      ...(profile ? { id: profile.id, revision: profile.revision } : {}),
      ...fields,
      ...(pricing ? { pricing } : {}),
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
        {service === "deepseek" && <p className="muted">已填写服务地址和创作模型，请提供密钥和模型单价。其他参数可在高级设置中调整。</p>}
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
        <div className="card">
          <h2>模型价格</h2>
          <p className="muted">请按服务商价格填写人民币单价，单位为元／百万 Token。费用仅为估算；免费模型请明确填写 0。未填写价格时可以保存，但不能调用。</p>
          <Field label="输入单价（元／百万 Token）">
            <input type="number" min="0" max="1000000" step="any" value={v.inputPrice} placeholder="填写输入价格" onChange={e => set({ ...v, inputPrice: e.target.value })} />
          </Field>
          <Field label="输出单价（元／百万 Token）">
            <input type="number" min="0" max="1000000" step="any" value={v.outputPrice} placeholder="填写输出价格" onChange={e => set({ ...v, outputPrice: e.target.value })} />
          </Field>
          <Field label="缓存输入单价（可选，元／百万 Token）">
            <input type="number" min="0" max="1000000" step="any" value={v.cachedInputPrice} placeholder="留空按普通输入单价估算" onChange={e => set({ ...v, cachedInputPrice: e.target.value })} />
          </Field>
        </div>
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
