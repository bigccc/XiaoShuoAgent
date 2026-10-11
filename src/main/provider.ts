import { DomainError } from "../shared/validation";
import type { TaskUsage } from "../shared/types";
export type ProviderCode =
  | "CONFIG"
  | "AUTH"
  | "MODEL"
  | "NETWORK"
  | "TIMEOUT"
  | "FORMAT"
  | "CANCELLED";
export class ProviderError extends Error {
  constructor(
    public code: ProviderCode,
    message: string,
    public partial = "",
    public transient = false,
  ) {
    super(message);
  }
}
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface ChatRequest {
  baseUrl: string;
  model: string;
  key?: string;
  messages: ChatMessage[];
  maxTokens: number;
  jsonResponse?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  onAttempt?: () => void;
}
export interface ChatResult {
  text: string;
  usage: TaskUsage;
}
export interface ProviderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}
export function chatUrl(base: string): string {
  try {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.pathname = url.pathname.replace(/\/$/, "");
    if (!url.pathname.endsWith("/chat/completions"))
      url.pathname += "/chat/completions";
    return url.href;
  } catch {
    throw new ProviderError(
      "CONFIG",
      "API 地址必须是不含凭据、查询参数的 HTTP 或 HTTPS 地址",
    );
  }
}
const unknownUsage = (): TaskUsage => ({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  estimated: false,
});
function usage(raw: any): TaskUsage {
  const value = (x: unknown) =>
    Number.isSafeInteger(x) && Number(x) >= 0 ? Number(x) : null;
  return raw
    ? {
        inputTokens: value(raw.prompt_tokens),
        outputTokens: value(raw.completion_tokens),
        totalTokens: value(raw.total_tokens),
        estimated: false,
      }
    : unknownUsage();
}
export class ChatProvider {
  private fetcher: typeof fetch;
  constructor(private options: ProviderOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
  }
  async complete(request: ChatRequest): Promise<ChatResult> {
    const url = chatUrl(request.baseUrl);
    if (
      !request.model.trim() ||
      !Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      request.maxTokens > 32000
    )
      throw new ProviderError("CONFIG", "模型名称或输出长度配置不正确");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (request.signal?.aborted)
        throw new ProviderError("CANCELLED", "任务已取消");
      try {
        return await this.once(url, request);
      } catch (error) {
        if (
          !(error instanceof ProviderError) ||
          !error.transient ||
          error.partial ||
          attempt === 2
        )
          throw error;
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new ProviderError("CANCELLED", "任务已取消"));
          };
          const timer = setTimeout(
            () => {
              request.signal?.removeEventListener("abort", cancel);
              resolve();
            },
            (this.options.retryDelayMs ?? 300) * (attempt + 1),
          );
          request.signal?.addEventListener("abort", cancel, { once: true });
          if (request.signal?.aborted) cancel();
        });
      }
    }
    throw new ProviderError("NETWORK", "模型连接失败");
  }
  private async once(url: string, r: ChatRequest): Promise<ChatResult> {
    const controller = new AbortController();
    let timedOut = false;
    let text = "";
    let reported = unknownUsage();
    let bytes = 0;
    const abort = () => controller.abort();
    r.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 90000);
    const emit = (content: unknown) => {
      if (typeof content !== "string")
        throw new ProviderError("FORMAT", "模型返回的正文格式不正确", text);
      text += content;
      if (text.length > 1_000_000)
        throw new ProviderError(
          "FORMAT",
          "模型输出超过长度限制",
          text.slice(0, 1_000_000),
        );
      if (content) r.onChunk?.(content);
    };
    const parse = (data: string) => {
      try {
        return JSON.parse(data);
      } catch {
        throw new ProviderError("FORMAT", "模型返回的 JSON 格式不正确", text);
      }
    };
    try {
      if (r.signal?.aborted) controller.abort();
      r.onAttempt?.();
      const response = await this.fetcher(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          ...(r.key ? { Authorization: `Bearer ${r.key}` } : {}),
        },
        body: JSON.stringify({
          model: r.model,
          messages: r.messages,
          max_tokens: r.maxTokens,
          ...(r.jsonResponse && new URL(url).hostname === "api.deepseek.com" && ["deepseek-flash", "deepseek-v4-pro"].includes(r.model)
            ? { thinking: { type: "disabled" }, response_format: { type: "json_object" } } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        void response.body?.cancel();
        if ([401, 403].includes(response.status))
          throw new ProviderError("AUTH", "模型鉴权失败，请检查 API 密钥");
        if (response.status === 404)
          throw new ProviderError(
            "MODEL",
            "模型或接口不存在，请检查地址和模型名称",
          );
        if ([408, 429, 500, 502, 503, 504].includes(response.status))
          throw new ProviderError(
            "NETWORK",
            "模型服务暂时不可用，请稍后重试",
            "",
            true,
          );
        throw new ProviderError(
          "CONFIG",
          "模型请求配置不受支持，请检查接口协议和模型配置",
        );
      }
      if (!response.body) throw new ProviderError("FORMAT", "模型返回了空响应");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let done = false;
      const streaming = response.headers
        .get("content-type")
        ?.includes("text/event-stream");
      const event = (block: string) => {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) return;
        if (data === "[DONE]") {
          done = true;
          return;
        }
        const raw = parse(data);
        if (raw.error || !Array.isArray(raw.choices))
          throw new ProviderError("FORMAT", "模型流式响应格式不正确", text);
        if (raw.usage) reported = usage(raw.usage);
        for (const choice of raw.choices) {
          if (
            choice.delta?.content !== undefined &&
            choice.delta.content !== null
          )
            emit(choice.delta.content);
          if (choice.finish_reason === "length")
            throw new ProviderError(
              "FORMAT",
              "模型输出达到长度上限，请提高预算或缩短请求",
              text,
            );
        }
      };
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 4_000_000)
            throw new ProviderError("FORMAT", "模型响应超过大小限制", text);
          pending += decoder.decode(chunk.value, { stream: true });
          if (streaming) {
            let match;
            while ((match = /\r?\n\r?\n/.exec(pending))) {
              const block = pending.slice(0, match.index);
              pending = pending.slice(match.index + match[0].length);
              event(block);
              if (done) break;
            }
            if (done) break;
          }
        }
        pending += decoder.decode();
        if (streaming) {
          if (!done)
            throw new ProviderError(
              "FORMAT",
              "模型流式响应未正常结束，已保留片段",
              text,
            );
        } else {
          const raw = parse(pending);
          if (
            raw.error ||
            !Array.isArray(raw.choices) ||
            !raw.choices[0]?.message
          )
            throw new ProviderError("FORMAT", "模型响应缺少正文");
          emit(raw.choices[0].message.content);
          if (raw.choices[0].finish_reason === "length")
            throw new ProviderError("FORMAT", "模型输出达到长度上限", text);
          reported = usage(raw.usage);
        }
        if (r.signal?.aborted)
          throw new ProviderError("CANCELLED", "任务已取消", text);
        if (!text.trim()) throw new ProviderError("FORMAT", "模型未返回正文");
        return { text, usage: reported };
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (r.signal?.aborted)
        throw new ProviderError("CANCELLED", "任务已取消", text);
      if (timedOut)
        throw new ProviderError(
          "TIMEOUT",
          "模型请求超时，已保留片段",
          text,
          true,
        );
      if (error instanceof ProviderError || error instanceof DomainError)
        throw error;
      // No provider-controlled messages or exception strings escape this boundary.
      throw new ProviderError(
        "NETWORK",
        "模型连接失败，请检查网络与 API 地址",
        text,
        true,
      );
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener("abort", abort);
    }
  }
}
