// Test-only main bootstrap: make any Keychain availability/access observable before
// importing the actual compiled production entry point. No OS Keychain is touched.
const { safeStorage } = require("electron");
const { appendFileSync } = require("node:fs");
for (const method of [
  "isEncryptionAvailable",
  "encryptString",
  "decryptString",
]) {
  safeStorage[method] = () => {
    appendFileSync(process.env.NOVEL_KEYCHAIN_OBSERVATION, method + "\n");
    throw new Error("Test Keychain is unavailable");
  };
}
import("../../out/main/index.js");
