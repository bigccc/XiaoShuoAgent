export type GenerationKind = "conversation" | "writing";
export interface PreviewPart { path: string; text: string }
export interface GenerationPreview {
  projectId: string;
  taskId: string;
  kind: GenerationKind;
  attemptId: string;
  phase: string;
  sequence: number;
  parts: PreviewPart[];
  completed: boolean;
}
export type GenerationDelta = Omit<GenerationPreview, "parts" | "completed"> & (
  | { op: "reset"; parts: PreviewPart[] }
  | { op: "append"; path: string; text: string }
  | { op: "end"; outcome: "completed" | "cancelled" }
);
export interface GenerationPreviewSnapshot { revision: number; previews: GenerationPreview[] }
