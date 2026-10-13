import { test, expect } from "vitest";
import { mkdir, mkdtemp, writeFile, symlink, rm, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// @ts-expect-error The Forge maker is a native ESM build script.
import { NativeDmgMaker } from "../scripts/native-dmg-maker.mjs";

const exec = promisify(execFile);

// Rewriting framework symlinks to the build directory breaks installed apps.
test.skipIf(process.platform !== "darwin")("DMG installs a self-contained framework after the build directory is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-dmg-test-"));
  const source = join(root, "build");
  const mount = join(root, "mounted");
  const installed = join(root, "Applications", "Fixture.app");
  const framework = "Contents/Frameworks/Electron Framework.framework";
  let mounted = false;
  try {
    const original = join(source, "Fixture.app", framework);
    await mkdir(join(original, "Versions/A/Resources"), { recursive: true });
    await writeFile(join(original, "Versions/A/Resources/icudtl.dat"), "icu fixture");
    await symlink("A", join(original, "Versions/Current"));
    await symlink("Versions/Current/Resources", join(original, "Resources"));
    const [dmg] = await new NativeDmgMaker({}).make({
      dir: source, makeDir: join(root, "make"), appName: "Fixture",
      packageJSON: { version: "0.0.0" }, targetArch: process.arch,
    });
    await exec("hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount]);
    mounted = true;
    expect(await readlink(join(mount, "Applications"))).toBe("/Applications");
    await exec("ditto", [join(mount, "Fixture.app"), installed]);
    await exec("hdiutil", ["detach", mount]);
    mounted = false;
    await rm(source, { recursive: true });
    expect(await readFile(join(installed, framework, "Resources/icudtl.dat"), "utf8")).toBe("icu fixture");
    expect(await readlink(join(installed, framework, "Versions/Current"))).toBe("A");
  } finally {
    if (mounted) await exec("hdiutil", ["detach", mount]);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
