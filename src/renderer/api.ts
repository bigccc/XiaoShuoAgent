import type { AppState, Command, CommandResult } from "../shared/types";
declare global {
  interface Window {
    novel: {
      invoke(command: Command): Promise<CommandResult>;
      snapshot(): Promise<AppState>;
      onBeforeClose(handler: () => void): () => void;
      closeReady(ready: boolean): Promise<void>;
    };
  }
}
export type Run = (
  command: Command,
) => Promise<Extract<CommandResult, { ok: true }>>;
