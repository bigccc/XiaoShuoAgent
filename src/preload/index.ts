import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../shared/types";
contextBridge.exposeInMainWorld("novel", {
  invoke: (command: Command) => ipcRenderer.invoke("novel:invoke", command),
  snapshot: () => ipcRenderer.invoke("novel:snapshot"),
  onBeforeClose: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("novel:before-close", listener);
    return () => ipcRenderer.removeListener("novel:before-close", listener);
  },
  closeReady: (ready: boolean) => ipcRenderer.invoke("novel:close", ready),
});
