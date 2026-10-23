import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error shared standalone audit calculation
import { contrast, composite, parseColor } from "../../scripts/audit-contrast.mjs";
let app: ElectronApplication;
let dir: string;
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
for (const theme of ["light", "dark"]) {
  test(`${theme} real CSS inheritance, transparent surfaces, hover, selection and focus`, async () => {
    dir = await mkdtemp(join(tmpdir(), "novel-contrast-"));
    app = await electron.launch({
      args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"],
      executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
      env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState();
    // A fixture in the actual renderer uses the shipped stylesheet and inherited root text.
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      const host = document.createElement("section");
      host.id = "contrast-fixture";
      host.style.cssText = "position:fixed;inset:10px;z-index:99999;background:var(--bg-surface);padding:20px;";
      host.innerHTML = '<p id="inherited">继承正文</p><button class="primary">主要按钮</button><button class="subtle">透明按钮</button><button class="danger">危险按钮</button><span class="badge ok">成功</span><span class="badge warn">警告</span><span class="badge danger">失败</span><p class="reader-text">选择正文</p><input aria-label="对比度输入" />';
      document.body.append(host);
    }, theme);
    const read = async (selector: string, pseudo?: string) => page.locator(selector).evaluate((el, pseudo) => {
      const own = getComputedStyle(el, pseudo);
      const backgrounds: string[] = [];
      for (let node: Element | null = el; node; node = node.parentElement) backgrounds.push(getComputedStyle(node).backgroundColor);
      return { color: own.color, background: own.backgroundColor, backgrounds, outline: own.outlineColor, outlineStyle: own.outlineStyle, border: own.borderColor, outlineWidth: own.outlineWidth };
    }, pseudo);
    const check = async (selector: string) => {
      const value = await read(selector);
      // Composite every ancestor layer, rather than treating transparent as white.
      let bg = parseColor("white");
      for (const layer of value.backgrounds.reverse()) bg = composite(parseColor(layer), bg);
      expect(contrast(value.color, `rgb(${bg.slice(0, 3).join(",")})`), `${theme} ${selector}`).toBeGreaterThanOrEqual(4.5);
    };
    for (const selector of ["#inherited", "button.primary", "button.subtle", "button.danger", ".badge.ok", ".badge.warn", ".badge.danger"]) {
      await check(`#contrast-fixture ${selector}`);
    }
    for (const selector of ["button.primary", "button.subtle", "button.danger"]) {
      await page.locator(`#contrast-fixture ${selector}`).hover();
      await page.waitForTimeout(200); // shipped background transition
      await check(`#contrast-fixture ${selector}`);
    }
    const input = page.getByLabel("对比度输入");
    await input.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const focus = await read("#contrast-fixture input");
    expect(focus.outlineStyle).toBe("solid");
    expect(focus.outlineWidth).toBe("3px");
    const surface = await page.locator("#contrast-fixture").evaluate(el => getComputedStyle(el).backgroundColor);
    expect(contrast(focus.outline, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(focus.border, focus.background)).toBeGreaterThanOrEqual(3);
    const selection = await read("#contrast-fixture .reader-text", "::selection");
    const reader = await read("#contrast-fixture .reader-text");
    expect(contrast(reader.color, selection.background)).toBeGreaterThanOrEqual(4.5);
  });
}
