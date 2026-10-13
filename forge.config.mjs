import { MakerZIP } from "@electron-forge/maker-zip";
import { NativeDmgMaker } from "./scripts/native-dmg-maker.mjs";
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
    ...(process.env.MAC_SIGN_IDENTITY
      ? {
          osxSign: {
            identity: process.env.MAC_SIGN_IDENTITY,
            hardenedRuntime: true,
          },
        }
      : {}),
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
