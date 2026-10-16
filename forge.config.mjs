import { readFileSync } from "node:fs";
import { MakerZIP } from "@electron-forge/maker-zip";
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
  makers: [new MakerZIP({}, ["darwin"]), new NativeDmgMaker({})],
};
