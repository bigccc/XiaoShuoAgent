import { MakerBase } from "@electron-forge/maker-base";
import { mkdir, mkdtemp, cp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// hdiutil ships with macOS; avoids native appdmg/image parser dependencies.
export class NativeDmgMaker extends MakerBase {
  name = "native-dmg";
  defaultPlatforms = ["darwin"];
  requiredExternalBinaries = ["hdiutil"];
  isSupportedOnCurrentPlatform() {
    return process.platform === "darwin";
  }
  async make({ dir, makeDir, appName, packageJSON, targetArch }) {
    const output = resolve(
      makeDir,
      "dmg",
      targetArch,
      `${appName}-${packageJSON.version}-${targetArch}.dmg`,
    );
    await mkdir(join(makeDir, "dmg", targetArch), { recursive: true });
    const staging = await mkdtemp(join(tmpdir(), "novel-dmg-"));
    try {
      await cp(join(dir, `${appName}.app`), join(staging, `${appName}.app`), {
        recursive: true,
      });
      await symlink("/Applications", join(staging, "Applications"));
      await promisify(execFile)(
        "hdiutil",
        [
          "create",
          "-volname",
          appName,
          "-srcfolder",
          staging,
          "-ov",
          "-format",
          "UDZO",
          output,
        ],
        { maxBuffer: 1024 * 1024 },
      );
      return [output];
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
