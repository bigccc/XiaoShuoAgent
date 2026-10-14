import type {StructureWorkspace,StructureCommand} from "./structure";
import type {VoiceRecord,VoiceJob,VoiceCommand} from "./voice";
import type {ScenePlan,SceneJob,SceneCommand} from "./scenes";
import type { ReaderCommand, ReadingWorkspace, TextSelection } from "./reader";
import type { RevisionCommand, RevisionJob } from "./revision";
import type { WritingCommand, WritingJob } from "./writing";
import type { RecallReference } from "./recall";
import type {StoryRecord,StoryExtractionJob,StoryCommand,StoryJobCommand} from "./story-state";
export type ID = string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface RecordMeta {
  id: ID;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectFields {
  title: string;
  background: string;
  genre: string;
  style: string;
  pace: string;
  targetWords: number;
  chapterWords: number;
}
export interface Project extends RecordMeta, ProjectFields {
  archived: boolean;
  authoring?: AuthoringState;
}
export type PlanningStage = "overview" | "settings" | "outline";
export type AuthoringStage = PlanningStage | "writing";
export interface AuthoringDocument {
  content: string;
  revision: number;
  approved: boolean;
  needsReview: boolean;
  history: {
    revision: number;
    content: string;
    createdAt: string;
    batchId?: ID;
  }[];
  sync?: StageSyncState;
}
export interface AuthoringState {
  activeStage: AuthoringStage;
  writingStarted?: boolean;
  documents: Partial<Record<PlanningStage, AuthoringDocument>>;
  reviewGroup?: PlanningStage[];
}
export interface AuthoringIntent {
  targetStage: AuthoringStage;
  outputStages: PlanningStage[];
  approveStages: PlanningStage[];
  allowWriting: boolean;
  preview: boolean;
  delegated: boolean;
  reconciliation: boolean;
}
export type NoteType =
  | "character"
  | "world"
  | "location"
  | "storyline"
  | "outline"
  | "chapterOutline"
  | "summary"
  | "timeline"
  | "knowledge"
  | "foreshadowing"
  | "supplement";
export type SyncField = "title" | "genre" | "background" | "style" | "pace";
export type SyncNoteType =
  | "character"
  | "world"
  | "location"
  | "storyline"
  | "outline"
  | "chapterOutline"
  | "supplement";
export interface StageBlockInput {
  id?: ID;
  kind: "field" | "note";
  field?: SyncField;
  noteId?: ID;
  noteType?: SyncNoteType;
  title?: string;
  text?: string;
  startLine?: number;
  endLine?: number;
  heading?: boolean;
}
export interface StageBundle {
  stage: PlanningStage;
  blocks: StageBlockInput[];
  removeNoteIds?: ID[];
  removeFields?: SyncField[];
}
export interface StageBinding {
  id: ID;
  kind: "field" | "note";
  field?: SyncField;
  noteId?: ID;
  heading?: boolean;
}
export interface StageSyncState {
  status: "synced" | "pending" | "running" | "failed" | "conflict";
  bindings: StageBinding[];
  lastSyncedContent: string;
  lastSyncedRevision: number;
  jobId?: ID;
  batchId?: ID;
  error?: string;
}
export interface SyncConflict {
  blockId: ID;
  title: string;
  reason: string;
  noteIds: ID[];
}
export interface StageSyncJob extends RecordMeta {
  projectId: ID;
  stage: PlanningStage;
  documentRevision: number;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "conflict"
    | "cancelled"
    | "interrupted";
  sourceContent: string;
  baseProjectRevision: number;
  baseNoteRevisions: { id: ID; revision: number }[];
  proposal?: StageBundle;
  conflicts: SyncConflict[];
  summary: string[];
  calls: number;
  usage: TaskUsage | null;
  profileId?: ID;
  error?: string;
}
export interface StageSyncSnapshot {
  fields: Pick<ProjectFields, SyncField>;
  notes: Note[];
  bindings: StageBinding[];
  content: string;
}
export interface StageSyncBatch extends RecordMeta {
  projectId: ID;
  stage: PlanningStage;
  jobId: ID;
  origin: "generation" | "draft" | "auxiliary" | "restore";
  before: StageSyncSnapshot;
  after: StageSyncSnapshot;
}
export interface SourceRevision {
  kind: "project" | "note" | "chapter";
  id: ID;
  revision: number;
}
export interface Note extends RecordMeta {
  projectId: ID;
  type: NoteType;
  title: string;
  body: string;
  sources: SourceRevision[];
  needsReview: boolean;
  history?: {
    revision: number;
    type: NoteType;
    title: string;
    body: string;
    createdAt: string;
  }[];
  archived?: boolean;
  syncManaged?: boolean;
  supplementStage?: PlanningStage;
}
export type ChapterStatus = "draft" | "confirmed";
export interface Chapter extends RecordMeta {
  contentHash?: string;
  wordCount?: number;
  contentLoaded?: boolean;
  projectId: ID;
  ordinal: number;
  title: string;
  content: string;
  status: ChapterStatus;
  needsReview: boolean;
  style: string;
  pace: string;
  writingStage?: "opening" | "complete";
}
export type VersionReason =
  | "create"
  | "save"
  | "confirm"
  | "restore"
  | "ai-candidate";
export interface ChapterVersion {
  id: ID;
  chapterId: ID;
  projectId: ID;
  chapterRevision: number;
  title: string;
  content: string;
  style: string;
  pace: string;
  status: ChapterStatus;
  reason: VersionReason;
  createdAt: string;
  taskId?: ID;
  restoredFrom?: ID;
  sourceRevisions: SourceRevision[];
  writingStage?: "opening" | "complete";
}
export interface ConversationResponse {
  message: string;
  artifacts?: {
    stage: PlanningStage;
    content?: string;
    blocks?: StageBlockInput[];
    removeNoteIds?: ID[];
    removeFields?: SyncField[];
  }[];
  suggestions?: string[];
  memory?: string;
  project?: Partial<
    Pick<ProjectFields, "title" | "background" | "genre" | "style" | "pace">
  >;
  notes?: { id?: ID; type: NoteType; title: string; body: string }[];
  chapters?: {
    id?: ID;
    title: string;
    content: string;
    stage: "opening" | "complete";
  }[];
  proposal?: { chapterIds: ID[]; reason: string };
}
export interface ResponseDiagnostics {
  transport: "sse" | "json" | "unknown";
  finishReason: "stop" | "length" | "content_filter" | "tool_calls" | "function_call" | "other" | null;
  receivedChars: number;
  reasoningChars: number;
  streamCompleted: boolean;
}
export interface ConversationAttempt {
  phase: "generate" | "repair";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  code?: string;
  error?: string;
  usage: TaskUsage | null;
  diagnostics?: ResponseDiagnostics;
  rawResponse?: string;
}
export interface ConversationTurn extends RecordMeta {
  projectId: ID;
  authoringIntent?: AuthoringIntent;
  authoringSource?: string;
  text: string;
  reply: string;
  status:
    | "running"
    | "completed"
    | "awaiting-author"
    | "failed"
    | "cancelled"
    | "interrupted";
  suggestions: string[];
  chapterIds: ID[];
  memory: string;
  contextWarnings: string[];
  contextReferences?: RecallReference[];
  usage: TaskUsage | null;
  profileId?: ID;
  chapterId?: ID;
  proposalTurnId?: ID;
  proposal?: { chapterIds: ID[]; reason: string };
  response?: ConversationResponse;
  rawResponse?: string;
  attempts?: ConversationAttempt[];
  recoveryPhase?: "requesting" | "retrying" | "repairing";
  error?: string;
}
export interface MaterialSnapshot {
  title: string;
  type: "expression" | "plot";
  source: string;
  content: string;
  explanation: string;
  approved: boolean;
  revision: number;
}
export interface Material extends RecordMeta {
  type: "expression" | "plot";
  title: string;
  source: string;
  content: string;
  explanation: string;
  approved: boolean;
  projectReferences: {
    projectId: ID;
    linkedAt: string;
    snapshot: MaterialSnapshot;
  }[];
}
export type ModelPurpose = "planning" | "writing" | "checking";
export interface ModelProfile extends RecordMeta {
  name: string;
  baseUrl: string;
  model: string;
  purpose: ModelPurpose;
  hasKey: boolean;
}
export type TaskStatus =
  | "waiting"
  | "running"
  | "awaiting-author"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface TaskUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimated: boolean;
}
export interface TaskRecord extends RecordMeta {
  projectId: ID;
  kind: "generation" | "planning" | "check" | "extraction" | "connection";
  status: TaskStatus;
  requestSnapshot: JsonValue;
  result: JsonValue;
  partial: string;
  usage: TaskUsage | null;
  calls: number;
  sourceRevisions: SourceRevision[];
  error?: string;
}
export interface CheckIssue extends RecordMeta {
  projectId: ID;
  chapterId?: ID;
  type:
    | "character"
    | "timeline"
    | "location"
    | "world"
    | "knowledge"
    | "foreshadowing";
  reason: string;
  evidence: {
    quote: string;
    source: SourceRevision;
    candidateVersionId?: ID;
  }[];
  status: "open" | "resolved" | "ignored";
}
export interface AppState {
  schemaVersion: number;
  persistence?: { lastRecoveryAt: string | null; recoveryError: string | null };
  projects: Project[];
  notes: Note[];
  chapters: Chapter[];
  versions: ChapterVersion[];
  materials: Material[];
  profiles: ModelProfile[];
  tasks: TaskRecord[];
  issues: CheckIssue[];
  conversations: ConversationTurn[];
  syncJobs: StageSyncJob[];
  syncBatches: StageSyncBatch[];
  readingWorkspaces?: ReadingWorkspace[];
  revisionJobs?: RevisionJob[];
  writingJobs?: WritingJob[];
  storyRecords?: StoryRecord[];
  storyJobs?: StoryExtractionJob[];
  scenePlans?:ScenePlan[];sceneJobs?:SceneJob[];
  voiceRecords?:VoiceRecord[];voiceJobs?:VoiceJob[];structureWorkspaces?:StructureWorkspace[];
}
type Existing = { id: ID; revision: number };
type Saving = { id?: ID; revision?: number };
export type DomainCommand =
  | ({ type: "project.create" } & Pick<ProjectFields, "title"> &
      Partial<Omit<ProjectFields, "title">>)
  | ({ type: "project.update"; patch: Partial<ProjectFields> } & Existing)
  | ({ type: "project.archive"; archived?: boolean } & Existing)
  | ({
      type: "note.save";
      projectId: ID;
      noteType: NoteType;
      title: string;
      body: string;
      sources: SourceRevision[];
    } & Saving)
  | ({ type: "note.delete" } & Existing)
  | {
      type: "chapter.create";
      projectId: ID;
      ordinal: number;
      title: string;
      style?: string;
      pace?: string;
    }
  | ({
      type: "chapter.save";
      content: string;
      title?: string;
      style?: string;
      pace?: string;
    } & Existing)
  | ({ type: "chapter.confirm" } & Existing)
  | ({ type: "chapter.restore"; versionId: ID } & Existing)
  | ({
      type: "material.save";
      materialType: Material["type"];
      title: string;
      source: string;
      content: string;
      explanation: string;
      approved: boolean;
    } & Saving)
  | ({ type: "material.delete" } & Existing)
  | ({ type: "material.link"; projectId: ID; linked?: boolean } & Existing)
  | ({
      type: "profile.save";
      name: string;
      baseUrl: string;
      model: string;
      purpose: ModelPurpose;
      apiKey?: string;
    } & Saving)
  | ({ type: "profile.delete" } & Existing)
  | ({ type: "issue.resolve"; status: "resolved" | "ignored" } & Existing);
export interface AiContextOptions {
  includeDraftIds?: ID[];
  noteIds?: ID[];
  materialIds?: ID[];
  allowAutoMaterials?: boolean;
}
export interface AiBase extends AiContextOptions {
  projectId: ID;
  profileId: ID;
  tokenBudget: number;
  instruction?: string;
}
export type AsyncCommand =
  | {
      type: "conversation.send";
      projectId: ID;
      text: string;
      profileId?: ID;
      chapterId?: ID;
      proposalTurnId?: ID;
      stage?: AuthoringStage;
      selection?: TextSelection;
      revisionScope?: RevisionJob["scope"];
      revisionChapterIds?: ID[];
      annotationIds?: ID[];
      tokenBudget?: number;
    }
  | {
      type: "authoring.save";
      id: ID;
      revision: number;
      stage: PlanningStage;
      content: string;
    }
  | {
      type: "authoring.sync";
      projectId: ID;
      stage: PlanningStage;
      profileId?: ID;
    }
  | { type: "authoring.retrySync" | "authoring.cancelSync"; id: ID }
  | {
      type: "authoring.resolveSync";
      id: ID;
      resolution: "draft" | "records";
      links?: Record<string, ID | null>;
    }
  | {
      type: "authoring.restore";
      projectId: ID;
      stage: PlanningStage;
      revision: number;
      historyRevision: number;
    }
  | { type: "conversation.cancel" | "conversation.retry"; id: ID }
  | { type: "model.test"; profileId: ID; projectId?: ID }
  | ({
      type: "ai.plan";
      step: NoteType | "idea";
      planningMaxWords?: number;
      maxOutputTokens?: number;
    } & AiBase)
  | ({
      type: "ai.chapter";
      chapterIds: ID[];
      authorizeBatch?: boolean;
      checkingProfileId?: ID;
      chapterWords?: number;
    } & AiBase)
  | ({ type: "ai.check"; chapterIds?: ID[] } & AiBase)
  | ({ type: "ai.extract"; sourceText?: string; source: string } & AiBase)
  | { type: "task.cancel"; id: ID }
  | { type: "task.resume"; id: ID; mode: "continue" | "rewrite" }
  | {
      type: "file.importMaterial";
      source: string;
      materialType: Material["type"];
    }
  | {
      type: "file.exportText" | "file.exportDocx";
      projectId: ID;
      includeDrafts?: boolean;
    }
  | { type: "file.backup"; projectId: ID }
  | { type: "file.importBackup" };
export type Command = DomainCommand | AsyncCommand | ReaderCommand | RevisionCommand | WritingCommand | StoryCommand | StoryJobCommand | SceneCommand | VoiceCommand | StructureCommand;
export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STORAGE"
  | "KEY_PROTECTION"
  | "PROVIDER"
  | "BUDGET"
  | "CANCELLED";
export type CommandResult =
  | { ok: true; entityId: ID; revision?: number }
  | { ok: false; error: { code: ErrorCode; message: string } };
export interface CandidateInput {
  chapterId: ID;
  content: string;
  taskId: ID;
  sourceRevisions: SourceRevision[];
}
