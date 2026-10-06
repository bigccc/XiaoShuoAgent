import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type {
  AppState,
  ChapterVersion,
  CheckIssue,
  ModelProfile,
  TaskRecord,
} from "../shared/types";
import {
  DomainError,
  validatePublicJson,
  validateSources,
  validateTask,
  validateIssue,
} from "../shared/validation";
export type Collection = Exclude<
  keyof AppState,
  "schemaVersion" | "persistence"
>;
export type Entity<K extends Collection> = AppState[K][number];
const collections: Collection[] = [
  "projects",
  "notes",
  "chapters",
  "versions",
  "materials",
  "profiles",
  "tasks",
  "issues",
];
export class Store {
  private db: DatabaseSync;
  private depth = 0;
  constructor(public readonly path: string) {
    if (path !== ":memory:" && !isAbsolute(path))
      throw new DomainError(
        "STORAGE",
        "数据库必须使用应用数据目录中的绝对路径",
      );
    const existing = path !== ":memory:" && existsSync(path);
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (version > 1)
        throw new DomainError(
          "STORAGE",
          "数据库版本较新，请使用更新版本的应用",
        );
      if (version < 1) {
        if (existing) this.backup(`${path}.before-v1-${Date.now()}.sqlite`);
        this.transaction(() => {
          for (const table of collections)
            this.db.exec(
              `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
            );
          this.db.exec(
            "CREATE TABLE IF NOT EXISTS credentials(profile_id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL); PRAGMA user_version=1;",
          );
        });
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (path !== ":memory:") chmodSync(path, 0o600);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close(): void {
    this.db.close();
  }
  backup(destination: string): void {
    if (!isAbsolute(destination))
      throw new DomainError("STORAGE", "备份必须使用绝对路径");
    this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    chmodSync(destination, 0o600);
  }
  transaction<T>(fn: () => T): T {
    const name = `domain_${this.depth++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (e) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
      throw e;
    } finally {
      this.depth--;
    }
  }
  list<K extends Collection>(table: K): Entity<K>[] {
    return this.db
      .prepare(`SELECT json FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(String(row.json)) as Entity<K>);
  }
  get<K extends Collection>(table: K, id: string): Entity<K> | undefined {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);
    return row ? (JSON.parse(String(row.json)) as Entity<K>) : undefined;
  }
  put<K extends Collection>(table: K, entity: Entity<K>): void {
    validatePublicJson(entity);
    this.db
      .prepare(
        `INSERT INTO ${table}(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
      )
      .run(entity.id, JSON.stringify(entity));
  }
  remove(table: Collection, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  snapshot(): AppState {
    const state = { schemaVersion: 1 } as AppState;
    for (const table of collections)
      (state[table] as unknown[]) = this.list(table);
    state.profiles = state.profiles.map((p) => ({
      ...p,
      hasKey: this.hasProfileKey(p.id),
    }));
    return state;
  }
  setProfileKey(profileId: string, ciphertext: Uint8Array | null): void {
    if (ciphertext === null) {
      this.db
        .prepare("DELETE FROM credentials WHERE profile_id=?")
        .run(profileId);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO credentials(profile_id,ciphertext) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET ciphertext=excluded.ciphertext",
      )
      .run(profileId, ciphertext);
  }
  getProfileKey(profileId: string): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT ciphertext FROM credentials WHERE profile_id=?")
      .get(profileId);
    return row ? new Uint8Array(row.ciphertext as Uint8Array) : undefined;
  }
  hasProfileKey(profileId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM credentials WHERE profile_id=?")
      .get(profileId);
  }
  saveTask(task: TaskRecord, expectedRevision?: number): TaskRecord {
    return this.transaction(() => {
      const old = this.get("tasks", task.id);
      if (
        old ? old.revision !== expectedRevision : expectedRevision !== undefined
      )
        throw new DomainError("CONFLICT", "任务已被修改，请刷新后重试");
      validateTask(task);
      if (
        old &&
        (!isDeepStrictEqual(old.requestSnapshot, task.requestSnapshot) ||
          !isDeepStrictEqual(old.sourceRevisions, task.sourceRevisions))
      )
        throw new DomainError(
          "VALIDATION",
          "已开始任务的请求与来源快照不能修改",
        );
      if (
        !task.id ||
        !task.projectId ||
        ![
          "waiting",
          "running",
          "awaiting-author",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(task.status) ||
        !Number.isSafeInteger(task.calls) ||
        task.calls < 0
      )
        throw new DomainError("VALIDATION", "任务数据格式不正确");
      const next = {
        ...task,
        createdAt: old?.createdAt ?? task.createdAt,
        revision: old ? old.revision + 1 : 1,
      };
      this.put("tasks", next);
      return next;
    });
  }
  saveIssue(issue: CheckIssue, expectedRevision?: number): CheckIssue {
    return this.transaction(() => {
      const old = this.get("issues", issue.id);
      if (
        old ? old.revision !== expectedRevision : expectedRevision !== undefined
      )
        throw new DomainError("CONFLICT", "检查问题已被修改，请刷新后重试");
      validateIssue(issue);
      const next = { ...issue, revision: old ? old.revision + 1 : 1 };
      this.put("issues", next);
      return next;
    });
  }
}
