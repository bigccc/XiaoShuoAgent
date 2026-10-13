import type { AppState, Command, CommandResult, Chapter, ChapterVersion, ConversationTurn } from "../shared/types";
import type { SearchResult } from "../shared/reader";
import type { RevisionJob } from "../shared/revision";
declare global {
  interface Window {
    novel: {
      invoke(command: Command): Promise<CommandResult>;
      snapshot(): Promise<AppState>;
      workspaceSnapshot(projectId?: string, since?: number): Promise<{ revision: number; state?: AppState; chaptersUnchanged?: boolean }>;
      chapter(id: string): Promise<Chapter>;
      chapterVersions(id: string): Promise<ChapterVersion[]>;
      conversation(id: string): Promise<ConversationTurn>;
      search(projectId: string, query: string, offset?: number): Promise<SearchResult>;
      revisionJob(id: string, offset?: number, limit?: number): Promise<RevisionJob>;
      onBeforeClose(handler: () => void): () => void;
      closeReady(ready: boolean): Promise<void>;
    };
  }
}
export type Run = (
  command: Command,
) => Promise<Extract<CommandResult, { ok: true }>>;
