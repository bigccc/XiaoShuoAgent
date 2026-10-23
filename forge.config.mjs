import { readFileSync } from "node:fs";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { NativeDmgMaker } from "./scripts/native-dmg-maker.mjs";
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const signingIdentity = process.env.MAC_SIGN_IDENTITY || "-";
const adHocSigning = signingIdentity === "-";
export default {
  outDir: process.env.NOVEL_RELEASE_DIR || `release/v${appVersion}`,
  packagerConfig: {
    name: "XiaoShuoAgent",
    appBundleId: "cn.xiaoshuoagent.desktop",
    appVersion,
    win32metadata: {
      CompanyName: "XiaoShuoAgent contributors",
      ProductName: "小说工坊",
      FileDescription: "小说工坊",
    },
    asar: true,
    appCategoryType: "public.app-category.productivity",
    ignore: [
      // Ship runtime files only; local tutorials and workspace material stay out.
      /^\/(?!out(?:\/|$)|node_modules(?:\/|$)|package\.json$|LICENSE$).+/,
      /^\/\.env(?:$|[.\/])/,
      /^\/src($|\/)/,
      /^\/tests($|\/)/,
      /^\/docs($|\/)/,
      /^\/adr($|\/)/,
      /^\/scripts($|\/)/,
      /^\/\.superpowers($|\/)/,
      /^\/\.tmp($|\/)/,
      /^\/test-results($|\/)/,
      /^\/playwright-report($|\/)/,
      /^\/release($|\/)/,
      /^\/\.git($|\/)/,
      /^\/.*\.sqlite/,
    ],
    // Rebranding Electron invalidates its linker signature. Seal the complete
    // preview bundle even without a Developer ID certificate; Gatekeeper still
    // requires an explicit user exception until signed and notarized publicly.
    osxSign: {
      identity: signingIdentity,
      identityValidation: !adHocSigning,
      hardenedRuntime: !adHocSigning,
      ...(adHocSigning
        ? {
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
            // osx-sign 2.x reads runtime options per file, not at the top level.
            optionsForFile: () => ({ timestamp: "none", hardenedRuntime: false }),
          }
        : {}),
    },
    ...(process.env.APPLE_NOTARIZATION_PROFILE
      ? {
          osxNotarize: {
            keychainProfile: process.env.APPLE_NOTARIZATION_PROFILE,
          },
        }
      : {}),
  },
  makers: [
    new MakerZIP({}, ["darwin", "win32"]),
    new NativeDmgMaker({}),
    new MakerSquirrel((arch) => ({
      name: "XiaoShuoAgent",
      authors: "XiaoShuoAgent contributors",
      description: "小说工坊：本机保存作品、支持长篇阅读与 AI 连续创作的桌面应用",
      setupExe: `XiaoShuoAgent-${appVersion}-win32-${arch}-Setup.exe`,
      noMsi: true,
    })),
  ],
};
