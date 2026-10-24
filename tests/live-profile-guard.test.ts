import { expect, it } from "vitest";
import { assertOfficialDeepSeekHttps } from "../scripts/live-profile-guard";

it("allows only the official DeepSeek HTTPS endpoint before using a protected key", () => {
  expect(assertOfficialDeepSeekHttps("https://api.deepseek.com/v1").origin).toBe("https://api.deepseek.com");
  expect(() => assertOfficialDeepSeekHttps("http://api.deepseek.com/v1")).toThrow("HTTPS");
  expect(() => assertOfficialDeepSeekHttps("https://api.deepseek.com.evil.example/v1")).toThrow("DeepSeek");
  expect(() => assertOfficialDeepSeekHttps("https://user:secret@api.deepseek.com/v1")).toThrow("HTTPS");
});
