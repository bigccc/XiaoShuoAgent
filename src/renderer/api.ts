import type { GenerationDelta, GenerationPreviewSnapshot } from "../shared/generation-preview";
import type {StructureWorkspace,StructureQuery,StructurePage} from "../shared/structure";
import type {VoiceRecord,VoiceWorkspace,VoiceQuery} from "../shared/voice";
import type {ScenePlan,SceneWorkspace} from "../shared/scenes";
import type {StoryRecord,StoryQuery,StoryWorkspace} from "../shared/story-state";
import type { AppState, Command, CommandResult, Chapter, ChapterVersion, ConversationTurn } from "../shared/types";
import type { SearchResult } from "../shared/reader";
import type { RevisionJob } from "../shared/revision";
import type { WritingIssue } from "../shared/writing";
declare global {
  interface Window {
    novel: {
      invoke(command: Command): Promise<CommandResult>;
      snapshot(): Promise<AppState>;
      workspaceSnapshot(projectId?: string, since?: number): Promise<{ revision: number; state?: AppState; chaptersUnchanged?: boolean }>;
      chapter(id: string): Promise<Chapter>;
      chapterVersions(id: string): Promise<ChapterVersion[]>;
      conversation(id: string): Promise<ConversationTurn>;
      writingIssues(id: string): Promise<{revision:number;issues:WritingIssue[]}>;
      search(projectId: string, query: string, offset?: number): Promise<SearchResult>;
      revisionJob(id: string, offset?: number, limit?: number): Promise<RevisionJob>;
      storyWorkspace(query:StoryQuery):Promise<StoryWorkspace>;
      structureQuery(q:StructureQuery):Promise<StructurePage>;
      structureConfig(id:string,history?:boolean):Promise<StructureWorkspace>;
      voiceWorkspace(query:VoiceQuery):Promise<VoiceWorkspace>;
      voiceRecord(id:string):Promise<VoiceRecord>;
      sceneWorkspace(chapterId:string):Promise<SceneWorkspace>;
      scenePlan(id:string):Promise<ScenePlan>;
      storyRecord(id:string):Promise<StoryRecord>;
      generationPreview(projectId: string, acknowledged?: string): Promise<GenerationPreviewSnapshot>;
      onGenerationDelta(handler: (event: GenerationDelta) => void): () => void;
      onBeforeClose(handler: () => void): () => void;
      closeReady(ready: boolean): Promise<void>;
    };
  }
}
export type Run = (
  command: Command,
) => Promise<Extract<CommandResult, { ok: true }>>;
