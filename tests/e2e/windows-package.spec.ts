import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Squirrel obsolete launch exits without opening a works database", async () => {
  test.skip(process.platform !== "win32" || !process.env.NOVEL_PACKAGED_EXECUTABLE, "Requires the packaged Windows executable");
  const dir = await mkdtemp(join(tmpdir(), "小说工坊-安装维护-"));
  const child = spawn(process.env.NOVEL_PACKAGED_EXECUTABLE!, ["--squirrel-obsolete"], {
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
    stdio: "ignore",
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Installer maintenance did not exit")); }, 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    expect(code).toBe(0);
    expect((await readdir(dir)).filter(name => name.endsWith(".sqlite"))).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
