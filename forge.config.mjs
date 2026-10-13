import { MakerZIP } from "@electron-forge/maker-zip";
import { NativeDmgMaker } from "./scripts/native-dmg-maker.mjs";
const signingIdentity = process.env.MAC_SIGN_IDENTITY || "-";
const adHocSigning = signingIdentity === "-";
export default {
  outDir: "release",
  packagerConfig: {
    name: "XiaoShuoAgent",
    appBundleId: "cn.xiaoshuoagent.desktop",
    appVersion: "0.1.0",
    asar: true,
    appCategoryType: "public.app-category.productivity",
    ignore: [
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
            optionsForFile: () => ({ timestamp: "none" }),
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
