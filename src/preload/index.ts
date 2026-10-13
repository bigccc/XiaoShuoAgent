import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../shared/types";
contextBridge.exposeInMainWorld("novel", {
  invoke: (command: Command) => ipcRenderer.invoke("novel:invoke", command),
  snapshot: () => ipcRenderer.invoke("novel:snapshot"),
  workspaceSnapshot: (projectId?: string, since?: number) => ipcRenderer.invoke("novel:workspace", projectId, since),
  chapter: (id: string) => ipcRenderer.invoke("novel:chapter", id),
  chapterVersions: (id: string) => ipcRenderer.invoke("novel:versions", id),
  conversation: (id: string) => ipcRenderer.invoke("novel:conversation", id),
  search: (projectId: string, query: string, offset?: number) => ipcRenderer.invoke("novel:search", projectId, query, offset),
  revisionJob: (id: string, offset?: number, limit?: number) => ipcRenderer.invoke("novel:revision", id, offset, limit),
  storyWorkspace:(query:unknown)=>ipcRenderer.invoke("novel:story-workspace",query),
  storyRecord:(id:string)=>ipcRenderer.invoke("novel:story-record",id),
  onBeforeClose: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("novel:before-close", listener);
    return () => ipcRenderer.removeListener("novel:before-close", listener);
  },
  closeReady: (ready: boolean) => ipcRenderer.invoke("novel:close", ready),
});
