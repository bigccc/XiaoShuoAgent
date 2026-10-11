import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join, isAbsolute, basename } from "node:path";
import type {
  AsyncCommand,
  Command,
  CommandResult,
  AppState,
} from "../shared/types";
import { DomainError, validatePublicJson } from "../shared/validation";
import { Store } from "./store";
import { DomainService } from "./domain";
import {
  ChatProvider,
  ProviderError,
  chatUrl,
  type ProviderOptions,
} from "./provider";
import { TaskRunner, type CredentialCodec } from "./tasks";
import { ProjectFiles, readMaterialFile, atomicWrite } from "./files";
import { ConversationRunner } from "./conversation";
import { StageSyncService } from "./stage-sync";
export interface FileDialogAdapter {
  open: (kind: "material" | "backup") => Promise<string | null>;
  save: (
    kind: "txt" | "docx" | "backup",
    suggestedName: string,
  ) => Promise<string | null>;
}
export interface AppServicesOptions {
  dataDir: string;
  credentials?: CredentialCodec;
  dialogs: FileDialogAdapter;
  fetch?: typeof fetch;
  provider?: Omit<ProviderOptions, "fetch">;
  maxContextChars?: number;
  recoveryIntervalMs?: number;
  syncDebounceMs?: number;
}
export class AppServices {
  readonly domain: DomainService;
  private store: Store;
  private files: ProjectFiles;
  private tasks: TaskRunner;
  private conversations: ConversationRunner;
  private sync: StageSyncService;
  private timer: ReturnType<typeof setInterval>;
  private recovering: Promise<void> | null = null;
  private lastDigest = "";
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private persistence = {
    lastRecoveryAt: null as string | null,
    recoveryError: null as string | null,
  };
  constructor(private options: AppServicesOptions) {
    if (!isAbsolute(options.dataDir))
      throw new DomainError("STORAGE", "应用数据目录必须是绝对路径");
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.store = new Store(join(options.dataDir, "works.sqlite"));
    this.domain = new DomainService(this.store, {
      encryptKey: options.credentials?.encrypt,
      onContentChange: (command, before) =>
        this.sync?.onContentChange(command, before),
    });
    this.files = new ProjectFiles(this.store);
    this.tasks = new TaskRunner(
      this.store,
      this.domain,
      new ChatProvider({ ...options.provider, fetch: options.fetch }),
      options.credentials,
      options.maxContextChars ?? 24000,
    );
    this.sync = new StageSyncService(
      this.store,
      this.domain,
      new ChatProvider({ ...options.provider, fetch: options.fetch }),
      options.credentials,
      options.syncDebounceMs ?? 5000,
      (id) =>
        this.store
          .list("conversations")
          .some((t) => t.projectId === id && t.status === "running") ||
        this.store
          .list("tasks")
          .some(
            (t) =>
              t.projectId === id && ["running", "waiting"].includes(t.status),
          ),
    );
    this.conversations = new ConversationRunner(
      this.store,
      this.domain,
      new ChatProvider({ ...options.provider, fetch: options.fetch }),
      options.credentials,
      options.maxContextChars ?? 48000,
      this.sync,
    );
    this.timer = setInterval(
      () => {
        if (!this.recovering && !this.disposed) {
          this.recovering = this.recovery().finally(() => {
            this.recovering = null;
          });
        }
      },
      options.recoveryIntervalMs ?? 15 * 60 * 1000,
    );
    this.timer.unref();
  }
  snapshot(): AppState {
    return { ...this.domain.snapshot(), persistence: { ...this.persistence } };
  }
  async dispatch(command: Command): Promise<CommandResult> {
    try {
      if (this.disposed) throw new DomainError("STORAGE", "应用正在关闭");
      if (
        !command ||
        typeof command !== "object" ||
        Array.isArray(command) ||
        typeof command.type !== "string"
      )
        throw new DomainError("VALIDATION", "请求格式不正确");
      if (!isAsync(command.type)) {
        if (command.type === "authoring.save") {
          const result = this.conversations.saveDocument(command);
          if (result.revision !== command.revision)
            this.sync.schedule(command.id, command.stage);
          return result;
        }
        if (command.type === "authoring.sync") {
          if (
            Object.keys(command).some(
              (k) => !["type", "projectId", "stage", "profileId"].includes(k),
            )
          )
            throw new DomainError("VALIDATION", "同步参数不正确");
          return {
            ok: true,
            entityId: this.sync.start(
              command.projectId,
              command.stage,
              command.profileId,
            ),
          };
        }
        if (
          command.type === "authoring.retrySync" ||
          command.type === "authoring.cancelSync"
        ) {
          if (
            typeof command.id !== "string" ||
            !command.id ||
            Object.keys(command).some((k) => !["type", "id"].includes(k))
          )
            throw new DomainError("VALIDATION", "同步参数不正确");
          if (command.type === "authoring.cancelSync") {
            this.sync.cancel(command.id);
            return { ok: true, entityId: command.id };
          }
          return { ok: true, entityId: this.sync.retry(command.id) };
        }
        if (command.type === "authoring.resolveSync") {
          if (
            Object.keys(command).some(
              (k) => !["type", "id", "resolution", "links"].includes(k),
            ) ||
            typeof command.id !== "string" ||
            !command.id ||
            (command.links !== undefined &&
              (!command.links ||
                typeof command.links !== "object" ||
                Array.isArray(command.links) ||
                Object.entries(command.links).some(
                  ([k, v]) => !k || (v !== null && typeof v !== "string"),
                )))
          )
            throw new DomainError("VALIDATION", "差异处理参数不正确");
          return {
            ok: true,
            entityId: this.sync.resolve(
              command.id,
              command.resolution,
              command.links,
            ),
          };
        }
        if (command.type === "authoring.restore") {
          if (
            Object.keys(command).some(
              (k) =>
                ![
                  "type",
                  "projectId",
                  "stage",
                  "revision",
                  "historyRevision",
                ].includes(k),
            ) ||
            !["overview", "settings", "outline"].includes(command.stage) ||
            !Number.isSafeInteger(command.revision) ||
            !Number.isSafeInteger(command.historyRevision)
          )
            throw new DomainError("VALIDATION", "恢复参数不正确");
          return {
            ok: true,
            entityId: this.sync.restore(
              command.projectId,
              command.stage,
              command.revision,
              command.historyRevision,
            ),
          };
        }
        if (command.type === "conversation.send") {
          await this.sync.barrier(command.projectId);
          return { ok: true, entityId: this.conversations.start(command) };
        }
        if (
          command.type === "conversation.cancel" ||
          command.type === "conversation.retry"
        ) {
          if (
            typeof command.id !== "string" ||
            !command.id ||
            Object.keys(command).some((k) => !["type", "id"].includes(k))
          )
            throw new DomainError("VALIDATION", "对话操作参数不正确");
          if (command.type === "conversation.cancel") {
            this.conversations.cancel(command.id);
            return { ok: true, entityId: command.id };
          }
          return { ok: true, entityId: this.conversations.retry(command.id) };
        }
        if (command.type === "profile.save") chatUrl(command.baseUrl);
        return this.domain.execute(command);
      }
      const c = command as Exclude<
        AsyncCommand,
        {
          type:
            | "conversation.send"
            | "conversation.cancel"
            | "conversation.retry"
            | "authoring.save"
            | "authoring.sync"
            | "authoring.retrySync"
            | "authoring.cancelSync"
            | "authoring.resolveSync"
            | "authoring.restore";
        }
      >;
      validateAsync(c);
      if (c.type === "task.cancel") {
        this.tasks.cancel(c.id);
        return { ok: true, entityId: c.id };
      }
      if (c.type === "task.resume") {
        const old = this.store.get("tasks", c.id);
        if (old && old.projectId !== "@connection")
          await this.sync.barrier(old.projectId);
        this.tasks.resume(c.id, c.mode);
        return { ok: true, entityId: c.id };
      }
      if (
        c.type === "model.test" ||
        c.type === "ai.plan" ||
        c.type === "ai.chapter" ||
        c.type === "ai.check"
      ) {
        if (c.type !== "model.test") await this.sync.barrier(c.projectId);
        return { ok: true, entityId: this.tasks.start(c) };
      }
      if (c.type === "ai.extract") {
        let text = c.sourceText;
        if (text === undefined) {
          const path = await this.options.dialogs.open("material");
          if (!path) throw new DomainError("CANCELLED", "已取消选择材料");
          text = await readMaterialFile(path);
        }
        if (!text.trim() || text.length > 2_000_000)
          throw new DomainError(
            "VALIDATION",
            "材料正文不能为空且不能超过长度限制",
          );
        return { ok: true, entityId: this.tasks.start(c, text) };
      }
      if (c.type === "file.importMaterial") {
        const path = await this.options.dialogs.open("material");
        if (!path) throw new DomainError("CANCELLED", "已取消导入");
        const content = await readMaterialFile(path);
        return this.domain.execute({
          type: "material.save",
          materialType: c.materialType,
          title: basename(path),
          source: c.source,
          content,
          explanation: "导入原文，等待作者审核或提取",
          approved: false,
        });
      }
      if (c.type === "file.importBackup") {
        const path = await this.options.dialogs.open("backup");
        if (!path) throw new DomainError("CANCELLED", "已取消导入");
        return { ok: true, entityId: await this.files.importBackup(path) };
      }
      const project = this.store.get("projects", c.projectId);
      if (!project) throw new DomainError("NOT_FOUND", "作品不存在");
      const kind =
        c.type === "file.exportText"
          ? "txt"
          : c.type === "file.exportDocx"
            ? "docx"
            : "backup";
      const name =
        project.title.replace(/[\\/\x00-\x1f:*?"<>|]/g, "_") +
        (kind === "backup" ? ".novel" : "." + kind);
      const path = await this.options.dialogs.save(kind, name);
      if (!path) throw new DomainError("CANCELLED", "已取消保存");
      if (c.type === "file.exportText")
        await this.files.exportText(
          c.projectId,
          path,
          c.includeDrafts ?? false,
        );
      else if (c.type === "file.exportDocx")
        await this.files.exportDocx(
          c.projectId,
          path,
          c.includeDrafts ?? false,
        );
      else await this.files.backup(c.projectId, path);
      return { ok: true, entityId: c.projectId };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof DomainError
            ? { code: error.code, message: error.message }
            : error instanceof ProviderError
              ? { code: "PROVIDER", message: error.message }
              : {
                  code: "STORAGE",
                  message: "文件或任务操作失败，请检查格式、权限和磁盘空间",
                },
      };
    }
  }
  private async recovery(): Promise<void> {
    try {
      const state = this.domain.snapshot();
      // A coherent JSON snapshot intentionally removes the entire model configuration table.
      const payload = {
        schemaVersion: state.schemaVersion,
        projects: state.projects,
        notes: state.notes,
        chapters: state.chapters,
        versions: state.versions,
        materials: state.materials,
        tasks: state.tasks,
        issues: state.issues,
        conversations: state.conversations.map(
          ({ profileId, ...turn }) => turn,
        ),
        syncJobs: state.syncJobs.map(({ profileId, ...job }) => job),
        syncBatches: state.syncBatches,
      };
      validatePublicJson(payload);
      const sha256 = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      if (sha256 === this.lastDigest) return;
      const directory = join(this.options.dataDir, "recovery"),
        now = new Date().toISOString();
      const file = join(
        directory,
        now.replaceAll(":", "-") + "-" + randomUUID() + ".novel",
      );
      await atomicWrite(
        file,
        JSON.stringify({
          format: "xiaoshuo-recovery",
          version: 3,
          sha256,
          payload,
        }),
      );
      const paths = (await readdir(directory))
        .filter((p) => p.endsWith(".novel"))
        .sort();
      for (const path of paths.slice(0, -20))
        await unlink(join(directory, path));
      this.lastDigest = sha256;
      this.persistence = { lastRecoveryAt: now, recoveryError: null };
    } catch {
      this.persistence.recoveryError =
        "自动恢复备份失败，请检查磁盘空间和数据目录权限";
    }
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    clearInterval(this.timer);
    this.disposePromise = (async () => {
      await this.tasks.dispose();
      await this.conversations.dispose();
      await this.sync.dispose();
      await this.recovering;
      await this.recovery();
      this.store.close();
    })();
    return this.disposePromise;
  }
}
const asyncTypes = [
  "model.test",
  "ai.plan",
  "ai.chapter",
  "ai.check",
  "ai.extract",
  "task.cancel",
  "task.resume",
  "file.importMaterial",
  "file.exportText",
  "file.exportDocx",
  "file.backup",
  "file.importBackup",
];
function isAsync(type: string): boolean {
  return asyncTypes.includes(type);
}
function validateAsync(value: AsyncCommand): void {
  const c = value as unknown as Record<string, unknown>;
  const common = [
    "projectId",
    "profileId",
    "tokenBudget",
    "instruction",
    "includeDraftIds",
    "noteIds",
    "materialIds",
    "allowAutoMaterials",
  ];
  const fields: Record<string, string[]> = {
    "model.test": ["profileId", "projectId"],
    "ai.plan": [...common, "step", "planningMaxWords", "maxOutputTokens"],
    "ai.chapter": [
      ...common,
      "chapterIds",
      "authorizeBatch",
      "checkingProfileId",
      "chapterWords",
    ],
    "ai.check": [...common, "chapterIds"],
    "ai.extract": [...common, "sourceText", "source"],
    "task.cancel": ["id"],
    "task.resume": ["id", "mode"],
    "file.importMaterial": ["source", "materialType"],
    "file.exportText": ["projectId", "includeDrafts"],
    "file.exportDocx": ["projectId", "includeDrafts"],
    "file.backup": ["projectId"],
    "file.importBackup": [],
  };
  const fail = () => {
    throw new DomainError("VALIDATION", "请求字段或参数格式不正确");
  };
  if (
    Object.keys(c).some((k) => k !== "type" && !fields[value.type].includes(k))
  )
    fail();
  const requiredString = (x: unknown) => {
    if (typeof x !== "string" || !x.trim() || x.length > 10000) fail();
  };
  for (const key of [
    "id",
    "projectId",
    "profileId",
    "checkingProfileId",
    "source",
  ])
    if (
      fields[value.type].includes(key) &&
      ((key !== "checkingProfileId" &&
        key !== "source" &&
        !(value.type === "model.test" && key === "projectId")) ||
        c[key] !== undefined)
    )
      requiredString(c[key]);
  for (const key of ["includeDrafts", "authorizeBatch", "allowAutoMaterials"])
    if (c[key] !== undefined && typeof c[key] !== "boolean") fail();
  for (const key of ["chapterIds", "includeDraftIds", "noteIds", "materialIds"])
    if (c[key] !== undefined) {
      if (!Array.isArray(c[key]) || (c[key] as unknown[]).length > 1000) fail();
      (c[key] as unknown[]).forEach(requiredString);
    }
  if (
    c.instruction !== undefined &&
    (typeof c.instruction !== "string" || c.instruction.length > 10000)
  )
    fail();
  if (value.type.startsWith("ai.")) {
    if (
      !Number.isSafeInteger(c.tokenBudget) ||
      Number(c.tokenBudget) < 100 ||
      Number(c.tokenBudget) > 10_000_000
    )
      fail();
  }
  for (const [field, max] of [
    ["planningMaxWords", 300000],
    ["maxOutputTokens", 32000],
  ] as const)
    if (
      c[field] !== undefined &&
      (!Number.isSafeInteger(c[field]) ||
        Number(c[field]) < 1 ||
        Number(c[field]) > max)
    )
      fail();
  if (
    value.type === "ai.chapter" &&
    (!Array.isArray(c.chapterIds) || !c.chapterIds.length)
  )
    fail();
  if (
    c.chapterWords !== undefined &&
    (!Number.isSafeInteger(c.chapterWords) ||
      Number(c.chapterWords) < 1 ||
      Number(c.chapterWords) > 16000)
  )
    fail();
  if (
    value.type === "ai.plan" &&
    ![
      "idea",
      "character",
      "world",
      "location",
      "storyline",
      "outline",
      "chapterOutline",
      "summary",
      "timeline",
      "knowledge",
      "foreshadowing",
    ].includes(String(c.step))
  )
    fail();
  if (value.type === "ai.extract") {
    requiredString(c.source);
    if (
      c.sourceText !== undefined &&
      (typeof c.sourceText !== "string" || c.sourceText.length > 2_000_000)
    )
      fail();
  }
  if (value.type === "file.importMaterial") {
    requiredString(c.source);
    if (!["expression", "plot"].includes(String(c.materialType))) fail();
  }
  if (
    value.type === "task.resume" &&
    !["continue", "rewrite"].includes(String(c.mode))
  )
    fail();
  validatePublicJson(c);
}
