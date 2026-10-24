export function assertOfficialDeepSeekHttps(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com" || url.username || url.password || url.port)
    throw new Error("真实验收仅允许官方 DeepSeek HTTPS 地址");
  return url;
}
