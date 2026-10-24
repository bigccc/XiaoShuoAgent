import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electron from "electron";
import { build } from "vite";

const outDir = resolve(".tmp/writing-review-live-runner");
const entry = resolve(outDir, "verify-writing-review-live.mjs");
await build({
  configFile: false,
  logLevel: "error",
  build: {
    target: "node22",
    ssr: resolve("scripts/verify-writing-review-live.ts"),
    outDir,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "verify-writing-review-live.mjs" },
    },
  },
});
if (!process.argv.includes("--build-only")) {
  const child = spawn(electron, [entry], { stdio: "inherit", env: process.env });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
}
