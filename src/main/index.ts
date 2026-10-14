import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  Menu,
} from "electron";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AppServices } from "./services";
import type { Command } from "../shared/types";

// Only the explicit test/development launch may move user data. Packaged ordinary launches use Electron userData.
if (process.env.NOVEL_TEST === "1" && process.env.NOVEL_DATA_DIR)
  app.setPath("userData", resolve(process.env.NOVEL_DATA_DIR));
let win: BrowserWindow | null = null,
  services: AppServices,
  quitting = false,
  closing = false;
const rendererFile = join(import.meta.dirname, "../renderer/index.html");
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const allowedUrl = devUrl || pathToFileURL(rendererFile).href;
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (
    !win ||
    event.sender !== win.webContents ||
    !event.senderFrame ||
    event.senderFrame !== win.webContents.mainFrame ||
    event.senderFrame.url !== allowedUrl
  )
    throw new Error("拒绝未授权的窗口请求");
}
app
  .whenReady()
  .then(() => {
    // Keychain availability can block on macOS (including under Rosetta). Never
    // initialize it while opening offline works; only touch it on credential use.
    const requireProtectedStorage = () => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("系统密钥保护不可用");
    };
    const credentials = {
      encrypt: (key: string) => {
        requireProtectedStorage();
        return safeStorage.encryptString(key);
      },
      decrypt: (bytes: Uint8Array) => {
        requireProtectedStorage();
        return safeStorage.decryptString(Buffer.from(bytes));
      },
    };
    services = new AppServices({
      dataDir: app.getPath("userData"),
      credentials,
      dialogs: {
        open: async (kind) => {
          const r = await dialog.showOpenDialog(win!, {
            title: kind === "backup" ? "导入作品／恢复备份" : "导入素材",
            properties: ["openFile"],
            filters: [
              {
                name: kind === "backup" ? "小说工坊作品包" : "文字材料",
                extensions:
                  kind === "backup" ? ["novel"] : ["txt", "docx", "doc"],
              },
            ],
          });
          return r.canceled ? null : r.filePaths[0];
        },
        save: async (kind, name) => {
          const r = await dialog.showSaveDialog(win!, {
            title: kind === "backup" ? "备份完整作品" : "导出正文",
            defaultPath: name,
            filters: [
              {
                name: kind === "backup" ? "作品包" : kind.toUpperCase(),
                extensions: [kind === "backup" ? "novel" : kind],
              },
            ],
          });
          return r.canceled ? null : (r.filePath ?? null);
        },
      },
    });
    ipcMain.handle("novel:invoke", async (event, command: Command) => {
      trusted(event);
      return services.dispatch(command);
    });
    ipcMain.handle("novel:snapshot", (event) => {
      trusted(event);
      return services.snapshot();
    });
    ipcMain.handle("novel:workspace", (event, projectId?: string, since?: number) => {
      trusted(event);
      return services.workspaceSnapshot(projectId, since);
    });
    ipcMain.handle("novel:chapter", (event, id: string) => { trusted(event); return services.chapter(id); });
    ipcMain.handle("novel:versions", (event, id: string) => { trusted(event); return services.chapterVersions(id); });
    ipcMain.handle("novel:conversation", (event, id: string) => { trusted(event); return services.conversation(id); });
    ipcMain.handle("novel:search", (event, projectId: string, query: string, offset?: number) => { trusted(event); return services.search(projectId, query, offset); });
    ipcMain.handle("novel:revision", (event, id: string, offset?: number, limit?: number) => { trusted(event); return services.revisionJob(id, offset, limit); });
    ipcMain.handle("novel:voice-workspace",(event,query)=>{trusted(event);return services.voiceWorkspace(query);});
    ipcMain.handle("novel:voice-record",(event,id:string)=>{trusted(event);return services.voiceRecord(id);});
    ipcMain.handle("novel:scene-workspace",(event,id:string)=>{trusted(event);return services.sceneWorkspace(id);});
    ipcMain.handle("novel:scene-plan",(event,id:string)=>{trusted(event);return services.scenePlan(id);});
    ipcMain.handle("novel:story-workspace",(event,query)=>{trusted(event);return services.storyWorkspace(query);});
    ipcMain.handle("novel:story-record",(event,id:string)=>{trusted(event);return services.storyRecord(id);});
    ipcMain.handle("novel:close", async (event, ready: boolean) => {
      trusted(event);
      if (!closing) return;
      if (!ready) {
        closing = false;
        return;
      }
      try {
        await services.dispose();
        quitting = true;
        win?.destroy();
        app.quit();
      } catch {
        closing = false;
        await dialog.showMessageBox(win!, {
          type: "error",
          message: "关闭前保存失败，请重试或先备份作品。",
        });
      }
    });
    win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1050,
      minHeight: 680,
      title: "小说工坊",
      backgroundColor: "#f6f3ec",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== allowedUrl) event.preventDefault();
    });
    win.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      win?.webContents.send("novel:before-close");
    });
    win.on("closed", () => {
      win = null;
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "小说工坊",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }] },
      ]),
    );
    if (devUrl) void win.loadURL(devUrl);
    else void win.loadFile(rendererFile);
  })
  .catch(async () => {
    await dialog.showErrorBox(
      "小说工坊启动失败",
      "无法打开本地数据，请检查磁盘空间与应用数据目录权限。",
    );
    quitting = true;
    app.quit();
  });
app.on("before-quit", (event) => {
  if (!quitting) {
    event.preventDefault();
    win?.close();
  }
});
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});
