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
  | "foreshadowing";
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
}
export type ChapterStatus = "draft" | "confirmed";
export interface Chapter extends RecordMeta {
  projectId: ID;
  ordinal: number;
  title: string;
  content: string;
  status: ChapterStatus;
  needsReview: boolean;
  style: string;
  pace: string;
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
  | { type: "model.test"; profileId: ID; projectId?: ID }
  | ({ type: "ai.plan"; step: NoteType | "idea" } & AiBase)
  | ({
      type: "ai.chapter";
      chapterIds: ID[];
      authorizeBatch?: boolean;
      checkingProfileId?: ID;
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
export type Command = DomainCommand | AsyncCommand;
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
