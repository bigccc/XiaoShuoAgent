import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { ChatProvider, ProviderError } from "../src/main/provider";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});
async function endpoint(handler: (res: ServerResponse, body: any) => void) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    handler(res, JSON.parse(raw));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}/v1`;
}
const input = {
  model: "fixture",
  messages: [{ role: "user" as const, content: "写一章" }],
  maxTokens: 80,
};
describe("compatible HTTP provider", () => {
  it("assembles fragmented Chinese SSE and reported usage", async () => {
    const baseUrl = await endpoint((res, body) => {
      expect(body.max_tokens).toBe(80);
      expect(body.stream).toBe(true);
      res.setHeader("Content-Type", "text/event-stream");
      const bytes = Buffer.from(
        'data: {"choices":[{"delta":{"content":"中文正文"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\ndata: [DONE]\n\n',
      );
      res.write(bytes.subarray(0, 55));
      setTimeout(() => res.end(bytes.subarray(55)), 5);
    });
    const chunks: string[] = [];
    const result = await new ChatProvider().complete({
      ...input,
      baseUrl,
      onChunk: (c) => chunks.push(c),
    });
    expect(result.text).toBe("中文正文");
    expect(chunks.join("")).toBe("中文正文");
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 4,
      totalTokens: 11,
      estimated: false,
    });
  });
  it("retries transient HTTP errors only twice and records each attempt", async () => {
    let calls = 0,
      attempts = 0;
    const baseUrl = await endpoint((res) => {
      calls++;
      res.writeHead(503);
      res.end("busy");
    });
    await expect(
      new ChatProvider({ retryDelayMs: 1 }).complete({
        ...input,
        baseUrl,
        onAttempt: () => attempts++,
      }),
    ).rejects.toMatchObject({ code: "NETWORK" });
    expect(calls).toBe(3);
    expect(attempts).toBe(3);
  });
  it("does not retry authentication and does not expose server text or keys", async () => {
    let calls = 0;
    const baseUrl = await endpoint((res) => {
      calls++;
      res.writeHead(401);
      res.end("leaked super-secret");
    });
    await expect(
      new ChatProvider().complete({ ...input, baseUrl, key: "super-secret" }),
    ).rejects.toMatchObject({
      code: "AUTH",
      message: "模型鉴权失败，请检查 API 密钥",
    });
    expect(calls).toBe(1);
  });
  it("preserves emitted content and refuses retry on truncated SSE", async () => {
    let calls = 0;
    const baseUrl = await endpoint((res) => {
      calls++;
      res.setHeader("Content-Type", "text/event-stream");
      res.end('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n');
    });
    await expect(
      new ChatProvider({ retryDelayMs: 1 }).complete({ ...input, baseUrl }),
    ).rejects.toMatchObject({ code: "FORMAT", partial: "未完成" });
    expect(calls).toBe(1);
  });
  it("aborts during output retaining partial without another call", async () => {
    let calls = 0;
    const controller = new AbortController();
    const baseUrl = await endpoint((res) => {
      calls++;
      res.setHeader("Content-Type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"片段"}}]}\n\n');
    });
    await expect(
      new ChatProvider().complete({
        ...input,
        baseUrl,
        signal: controller.signal,
        onChunk: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", partial: "片段" });
    expect(calls).toBe(1);
  });
  it("parses JSON response but keeps absent usage unknown", async () => {
    const baseUrl = await endpoint((res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "结果" } }] }));
    });
    expect(
      await new ChatProvider().complete({ ...input, baseUrl }),
    ).toMatchObject({
      text: "结果",
      usage: { totalTokens: null, estimated: false },
    });
  });
  it("rejects malformed JSON and times out a stalled request", async () => {
    const baseUrl = await endpoint((res) => {
      res.end("{bad");
    });
    await expect(
      new ChatProvider().complete({ ...input, baseUrl }),
    ).rejects.toMatchObject({ code: "FORMAT" });
    let calls = 0;
    const stalled = await endpoint(() => {
      calls++;
    });
    await expect(
      new ChatProvider({ timeoutMs: 15, retryDelayMs: 1 }).complete({
        ...input,
        baseUrl: stalled,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(calls).toBe(3);
  });
  it("rejects credentials/query in URL and follows no redirect", async () => {
    await expect(
      new ChatProvider().complete({
        ...input,
        baseUrl: "https://user:key@example.com/v1",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      new ChatProvider().complete({
        ...input,
        baseUrl: "https://example.com/v1?token=secret",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    const baseUrl = await endpoint((res) => {
      res.writeHead(302, { Location: "http://example.com" });
      res.end();
    });
    await expect(
      new ChatProvider().complete({ ...input, baseUrl }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
