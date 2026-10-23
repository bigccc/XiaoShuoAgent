import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
let app: ElectronApplication, page: Page, dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-keyboard-"));
  app = await electron.launch({ args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"], executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE, env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir } });
  page = await app.firstWindow(); await page.waitForLoadState();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].focus());
  await page.bringToFront();
});
test.afterEach(async () => { await app?.evaluate(({app}) => app.exit(0)).catch(()=>{}); await app?.close(); await rm(dir,{recursive:true,force:true}); });
async function connection() {
  await page.getByRole("button",{name:"设置",exact:true}).click();
  await page.getByRole("button",{name:"添加 AI 连接",exact:true}).first().click();
  await page.getByLabel("API 密钥").fill("fixture-key");
}
test("Windows Ctrl save and navigation retain unsaved edit protection", async () => {
  await page.evaluate(() => Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true }));
  await connection();
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await page.evaluate(() => window.novel.snapshot())).profiles.length).toBe(1);
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByLabel("配置名称").fill("Windows 未保存连接");
  await page.keyboard.press("Control+1");
  const dialog = page.getByRole("dialog", { name: "尚有未保存的修改" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "返回编辑", exact: true }).click();
  await expect(page.getByLabel("配置名称")).toHaveValue("Windows 未保存连接");
});
test("primary shortcut saves a manual form in place and primary navigation protects unsaved edits",async()=>{
  await connection(); await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async()=> (await page.evaluate(()=>window.novel.snapshot())).profiles.length).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByText("高级设置",{exact:true}).click();
  await page.getByLabel("配置名称").fill("未保存连接");
  await page.keyboard.press("ControlOrMeta+1");
  const dialog=page.getByRole("dialog",{name:"尚有未保存的修改"});
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty("tagName","DIALOG");
  await page.screenshot({path:".tmp/stream-preview-20261017/keyboard-unsaved-dialog.png"});
  await expect(dialog.getByRole("button",{name:"保存后离开",exact:true})).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button",{name:"放弃修改并离开",exact:true})).toBeFocused();
  await page.keyboard.press("Tab"); await expect(dialog.getByRole("button",{name:"保存后离开",exact:true})).toBeFocused();
  await page.keyboard.press("ControlOrMeta+5"); await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("配置名称")).toHaveValue("未保存连接");
  await expect(page.getByLabel("配置名称")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+1"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button",{name:"放弃修改并离开",exact:true}).click();
  await expect(page.getByRole("button",{name:"新建作品",exact:true})).toBeVisible();
});
test("diagnostics uses native focus containment and restores the trigger on Escape",async()=>{
  await page.getByRole("button",{name:"新建作品",exact:true}).click(); await page.getByRole("button",{name:"创建作品",exact:true}).click();
  const trigger=page.getByRole("button",{name:"诊断",exact:true}); await trigger.click();
  const dialog=page.getByRole("dialog",{name:"对话诊断"}); await expect(dialog).toHaveJSProperty("tagName","DIALOG");
  await expect(page.getByLabel("关闭诊断")).toBeFocused(); await page.keyboard.press("Tab"); await expect(page.getByLabel("关闭诊断")).toBeFocused();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
});
test("global shortcuts ignore composition, repeat and unavailable project destinations",async()=>{
  await page.keyboard.press("ControlOrMeta+2"); await expect(page.getByRole("button",{name:"新建作品",exact:true})).toBeVisible();
  await page.evaluate((mac)=>{ window.dispatchEvent(new KeyboardEvent("keydown",{key:"5",metaKey:mac,ctrlKey:!mac,repeat:true,bubbles:true})); window.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})); window.dispatchEvent(new KeyboardEvent("keydown",{key:"5",metaKey:mac,ctrlKey:!mac,bubbles:true})); }, process.platform === "darwin");
  await expect(page.getByRole("button",{name:"新建作品",exact:true})).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));
  await page.keyboard.press("ControlOrMeta+5"); await expect(page.getByRole("heading",{name:"AI 连接",exact:true})).toBeVisible();
});
test("save failure preserves manual text and busy leave dialog rejects Escape and repeated actions", async () => {
  await connection();
  await app.evaluate(({ipcMain}) => {
    ipcMain.removeHandler("novel:invoke");
    ipcMain.handle("novel:invoke", async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return {ok:false,error:{code:"IO",message:"回归：磁盘写入失败"}};
    });
  });
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("API 密钥")).toHaveValue("fixture-key");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+1");
  const dialog=page.getByRole("dialog",{name:"尚有未保存的修改"});
  await dialog.getByRole("button",{name:"保存后离开",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"返回编辑",exact:true})).toBeDisabled();
  await page.keyboard.press("Escape"); await page.keyboard.press("ControlOrMeta+1");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"返回编辑",exact:true})).toBeEnabled();
  await dialog.getByRole("button",{name:"返回编辑",exact:true}).click();
  await expect(page.getByLabel("API 密钥")).toHaveValue("fixture-key");
});
test("primary shortcut flushes automatic editors before protected navigation", async () => {
  await page.getByRole("button",{name:"新建作品",exact:true}).click(); await page.getByRole("button",{name:"创建作品",exact:true}).click();
  await expect(page.getByLabel("创作消息")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+4");
  await page.getByLabel("简介与背景",{exact:true}).fill("键盘自动保存正文");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async()=> (await page.evaluate(()=>window.novel.snapshot())).projects[0].background).toBe("键盘自动保存正文");
  await page.keyboard.press("ControlOrMeta+3"); await expect(page.getByText("先在创作中写下第一章，再来看稿。")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+2"); await expect(page.getByLabel("创作消息")).toBeVisible();
});
test("manual shortcut runs native required-field validation before saving", async () => {
  await connection(); await page.getByText("高级设置",{exact:true}).click();
  await page.getByLabel("配置名称").fill(""); await page.getByLabel("API 密钥").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByLabel("配置名称")).toBeFocused();
  expect((await page.evaluate(()=>window.novel.snapshot())).profiles).toHaveLength(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("diagnostics Tab reaches recovery details before wrapping to close", async () => {
  const server=createServer(async(req,res)=>{ for await(const _ of req) {} res.writeHead(401,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"fixture unauthorized"}})); });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  try {
    await page.evaluate(async(baseUrl)=>{await window.novel.invoke({type:"profile.save", pricing: { currency: "CNY", input: 0, output: 0 },name:"键盘诊断",baseUrl,model:"fixture",purpose:"writing"});},`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`);
    await page.getByRole("button",{name:"新建作品",exact:true}).click(); await page.getByRole("button",{name:"创建作品",exact:true}).click();
    await page.getByLabel("创作消息").fill("诊断焦点回归"); await page.getByRole("button",{name:"发送",exact:true}).click();
    await expect.poll(async()=> (await page.evaluate(()=>window.novel.snapshot())).conversations[0]?.status).toBe("failed");
    await page.getByRole("button",{name:"诊断",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"对话诊断"});
    await expect(dialog.locator("summary").first()).toBeVisible();
    await expect(page.getByLabel("关闭诊断")).toBeFocused();
    await page.keyboard.press("Tab"); await expect(dialog.locator("summary").first()).toBeFocused();
    await page.keyboard.press("Tab"); await expect(page.getByLabel("关闭诊断")).toBeFocused();
  } finally { await new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}); }
});
test("ordinary manual submit and primary shortcut share one busy save and lock editable fields", async () => {
  await connection();
  await app.evaluate(({ipcMain})=>{
    const fixture=globalThis as typeof globalThis & {keyboardCalls?:number}; fixture.keyboardCalls=0;
    ipcMain.removeHandler("novel:invoke"); ipcMain.handle("novel:invoke",async()=>{fixture.keyboardCalls!++;await new Promise(r=>setTimeout(r,800));return {ok:false,error:{code:"IO",message:"fixture disk failure"}};});
  });
  await page.getByRole("button",{name:"保存连接",exact:true}).click();
  await expect(page.getByLabel("API 密钥")).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+s");
  expect(await app.evaluate(()=> (globalThis as typeof globalThis & {keyboardCalls?:number}).keyboardCalls)).toBe(1);
  await expect(page.getByLabel("API 密钥")).toBeEnabled();
  await expect(page.getByLabel("API 密钥")).toHaveValue("fixture-key");
});
