import type { GenerationDelta } from "../shared/generation-preview";
import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../shared/types";
contextBridge.exposeInMainWorld("novel", {
  invoke: (command: Command) => ipcRenderer.invoke("novel:invoke", command),
  billingQuote: (command:unknown) => ipcRenderer.invoke("novel:billing-quote", command),
  billingSummary: (id:string) => ipcRenderer.invoke("novel:billing-summary", id),
  snapshot: () => ipcRenderer.invoke("novel:snapshot"),
  workspaceSnapshot: (projectId?: string, since?: number) => ipcRenderer.invoke("novel:workspace", projectId, since),
  chapter: (id: string) => ipcRenderer.invoke("novel:chapter", id),
  chapterVersions: (id: string) => ipcRenderer.invoke("novel:versions", id),
  conversation: (id: string) => ipcRenderer.invoke("novel:conversation", id),
  writingIssues: (id: string) => ipcRenderer.invoke("novel:writing-issues", id),
  search: (projectId: string, query: string, offset?: number) => ipcRenderer.invoke("novel:search", projectId, query, offset),
  revisionJob: (id: string, offset?: number, limit?: number) => ipcRenderer.invoke("novel:revision", id, offset, limit),
  storyWorkspace:(query:unknown)=>ipcRenderer.invoke("novel:story-workspace",query),
  structureQuery:(q:unknown)=>ipcRenderer.invoke("novel:structure-query",q),
  structureConfig:(id:string,history=false)=>ipcRenderer.invoke("novel:structure-config",id,history),
  voiceWorkspace:(query:unknown)=>ipcRenderer.invoke("novel:voice-workspace",query),
  voiceRecord:(id:string)=>ipcRenderer.invoke("novel:voice-record",id),
  sceneWorkspace:(chapterId:string)=>ipcRenderer.invoke("novel:scene-workspace",chapterId),
  scenePlan:(id:string)=>ipcRenderer.invoke("novel:scene-plan",id),
  storyRecord:(id:string)=>ipcRenderer.invoke("novel:story-record",id),
  generationPreview: (projectId: string, acknowledged?: string) => ipcRenderer.invoke("novel:generation-preview", projectId, acknowledged),
  onGenerationDelta: (handler: (event: GenerationDelta) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, delta: GenerationDelta) => handler(delta);
    ipcRenderer.on("novel:generation-delta", listener);
    return () => ipcRenderer.removeListener("novel:generation-delta", listener);
  },
  onBeforeClose: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("novel:before-close", listener);
    return () => ipcRenderer.removeListener("novel:before-close", listener);
  },
  closeReady: (ready: boolean) => ipcRenderer.invoke("novel:close", ready),
});
