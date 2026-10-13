import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type {
  AppState,
  ChapterVersion,
  CheckIssue,
  ModelProfile,
  TaskRecord,
  Chapter,
} from "../shared/types";
import type { SearchResult } from "../shared/reader";
import type { RevisionJob } from "../shared/revision";
import { validateWritingJob } from "../shared/writing";
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
export type Entity<K extends Collection> = NonNullable<AppState[K]>[number];
const collections: Collection[] = [
  "projects",
  "notes",
  "chapters",
  "versions",
  "materials",
  "profiles",
  "tasks",
  "issues",
  "conversations",
  "syncJobs",
  "syncBatches",
  "readingWorkspaces",
  "revisionJobs",
  "writingJobs",
];
export class Store {
  private db: DatabaseSync;
  private depth = 0;
  private generation = 0;
  private chapterGeneration = 0;
  private dataVersion = -1;
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
      if (version > 5)
        throw new DomainError(
          "STORAGE",
          "数据库版本较新，请使用更新版本的应用",
        );
      if (version < 1) {
        if (existing) this.backup(`${path}.before-v1-${Date.now()}.sqlite`);
        this.transaction(() => {
          for (const table of collections.filter(t => !["syncJobs", "syncBatches", "readingWorkspaces", "revisionJobs", "writingJobs"].includes(t)))
            this.db.exec(
              `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
            );
          this.db.exec(
            "CREATE TABLE IF NOT EXISTS credentials(profile_id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL); PRAGMA user_version=1;",
          );
        });
      }
      if (version < 2) {
        if (existing && version === 1) this.backup(`${path}.before-v2-${Date.now()}.sqlite`);
        this.transaction(() => this.db.exec("CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version=2;"));
      }
      if (version < 3) {
        if (existing) this.backup(`${path}.before-v3-${Date.now()}.sqlite`);
        this.transaction(() => this.db.exec("CREATE TABLE IF NOT EXISTS syncJobs(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS syncBatches(id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version=3;"));
      }
      if (version < 4) {
        if (existing && version >= 3) this.backup(`${path}.before-v4-${Date.now()}.sqlite`);
        this.transaction(() => {
          this.db.exec("CREATE TABLE IF NOT EXISTS readingWorkspaces(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revisionJobs(id TEXT PRIMARY KEY, json TEXT NOT NULL);");
          const columns = this.db.prepare("PRAGMA table_info(chapters)").all();
          if (!columns.some(c => c.name === "words")) this.db.exec("ALTER TABLE chapters ADD COLUMN words INTEGER NOT NULL DEFAULT 0;");
          if (!columns.some(c => c.name === "content_hash")) this.db.exec("ALTER TABLE chapters ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';");
          for (const row of this.db.prepare("SELECT id,json FROM chapters").all()) {
            const chapter = JSON.parse(String(row.json)) as Chapter;
            this.db.prepare("UPDATE chapters SET words=?,content_hash=? WHERE id=?").run(chapter.content.replace(/\s/g, "").length, createHash("sha256").update(chapter.content).digest("hex"), String(row.id));
          }
          this.db.exec("PRAGMA user_version=4;");
        });
      }
      if (version < 5) {
        if (existing && version >= 4) this.backup(`${path}.before-v5-${Date.now()}.sqlite`);
        this.transaction(() => this.db.exec("CREATE TABLE IF NOT EXISTS writingJobs(id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version=5;"));
      }
      for (const table of collections.filter(t => t !== "profiles"))
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_project ON ${table}(json_extract(json,'$.projectId'));`);
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
    if (table === "writingJobs") validateWritingJob(entity);
    if (table === "chapters") {
      const chapter = entity as Chapter;
      const { contentLoaded: _loaded, wordCount: _words, contentHash: _hash, ...stored } = chapter;
      this.db.prepare("INSERT INTO chapters(id,json,words,content_hash) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, words=excluded.words, content_hash=excluded.content_hash")
        .run(chapter.id, JSON.stringify(stored), chapter.content.replace(/\s/g, "").length, createHash("sha256").update(chapter.content).digest("hex"));
      this.generation++;
      this.chapterGeneration = this.generation;
      return;
    }
    this.db
      .prepare(
        `INSERT INTO ${table}(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
      )
      .run(entity.id, JSON.stringify(entity));
    this.generation++;
    if (table === "chapters") this.chapterGeneration = this.generation;
  }
  remove(table: Collection, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    this.generation++;
    if (table === "chapters") this.chapterGeneration = this.generation;
  }
  snapshot(): AppState {
    const state = { schemaVersion: 5 } as AppState;
    for (const table of collections)
      (state[table] as unknown[]) = this.list(table);
    state.profiles = state.profiles.map((p) => ({
      ...p,
      hasKey: this.hasProfileKey(p.id),
    }));
    return state;
  }
  setProfileKey(profileId: string, ciphertext: Uint8Array | null): void {
    this.generation++;
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
  selectByProject<K extends Collection>(table: K, projectId: string): Entity<K>[] {
    return this.db.prepare(`SELECT json FROM ${table} WHERE json_extract(json,'$.projectId')=? ORDER BY rowid`).all(projectId)
      .map(row => JSON.parse(String(row.json)) as Entity<K>);
  }
  chapterMetadata(projectId?: string): Chapter[] {
    return this.db.prepare(`SELECT json_set(json_remove(json,'$.content'),'$.content','','$.wordCount',words,'$.contentHash',content_hash,'$.contentLoaded',json('false')) AS json FROM chapters ${projectId ? "WHERE json_extract(json,'$.projectId')=?" : ""} ORDER BY json_extract(json,'$.ordinal')`)
      .all(...(projectId ? [projectId] : [])).map(row => JSON.parse(String(row.json)) as Chapter);
  }
  chapterVersions(chapterId: string): ChapterVersion[] {
    return this.db.prepare("SELECT json FROM versions WHERE json_extract(json,'$.chapterId')=? ORDER BY json_extract(json,'$.chapterRevision') DESC, json_extract(json,'$.createdAt') DESC")
      .all(chapterId).map(row => JSON.parse(String(row.json)) as ChapterVersion);
  }
  workspaceSnapshot(projectId?: string, since?: number): { revision: number; state?: AppState; chaptersUnchanged?: boolean } {
    const currentDataVersion = Number(this.db.prepare("PRAGMA data_version").get()?.data_version);
    if (this.dataVersion !== -1 && currentDataVersion !== this.dataVersion) {
      this.generation++;
      this.chapterGeneration = this.generation;
    }
    this.dataVersion = currentDataVersion;
    if (since === this.generation) return { revision: this.generation };
    const scoped = <K extends Collection>(table: K) => projectId ? this.selectByProject(table, projectId) : this.list(table);
    const projects = this.list("projects");
    const chaptersUnchanged = since !== undefined && since >= this.chapterGeneration;
    const state: AppState = {
      schemaVersion: 5, projects,
      chapters: chaptersUnchanged ? [] : this.chapterMetadata(), versions: [],
      notes: projectId ? scoped("notes") : [],
      materials: this.list("materials"),
      profiles: this.list("profiles").map(p => ({ ...p, hasKey: this.hasProfileKey(p.id) })),
      tasks: scoped("tasks"), issues: projectId ? scoped("issues") : [],
      conversations: [], syncJobs: [], syncBatches: [],
      readingWorkspaces: projectId ? scoped("readingWorkspaces") : [], revisionJobs: [], writingJobs: [],
    };
    // Projections happen inside SQLite so discarded full-text JSON never crosses IPC.
    if (projectId) {
      state.conversations = this.db.prepare("SELECT json_remove(json,'$.rawResponse','$.response','$.attempts[0].rawResponse','$.attempts[1].rawResponse','$.attempts[2].rawResponse') AS json FROM conversations WHERE json_extract(json,'$.projectId')=? ORDER BY rowid")
        .all(projectId).map(row => {
          const turn = JSON.parse(String(row.json));
          if (turn.status === "completed" && turn.authoringIntent?.outputStages?.length)
            turn.response = { message: turn.reply, artifacts: turn.authoringIntent.outputStages.map((stage: string) => ({ stage })) };
          return turn;
        });
      state.syncJobs = this.db.prepare("SELECT json_remove(json,'$.sourceContent') AS json FROM syncJobs WHERE json_extract(json,'$.projectId')=? ORDER BY rowid")
        .all(projectId).map(row => ({ sourceContent: "", ...JSON.parse(String(row.json)) }));
      state.revisionJobs = this.db.prepare("SELECT json_set(json_remove(json,'$.candidates','$.notes','$.chapterSources','$.noteSources','$.referenceChapterSources','$.sourceProjectDigest','$.sourceProfileDigest'),'$.candidateCount',json_array_length(json,'$.candidates'),'$.candidatePendingCount',(SELECT count(*) FROM json_each(json_extract(revisionJobs.json,'$.candidates')) WHERE json_extract(value,'$.status')='pending')) AS json FROM revisionJobs WHERE json_extract(json,'$.projectId')=? ORDER BY rowid")
        .all(projectId).map(row => ({ ...JSON.parse(String(row.json)), candidates: [], notes: [] }));
      state.writingJobs = this.db.prepare("SELECT json_set(json_remove(json,'$.plan'),'$.issues',json((SELECT json_group_array(json_remove(value,'$.evidence')) FROM json_each(json_extract(writingJobs.json,'$.issues')))),'$.checkIssues',json((SELECT json_group_array(json_remove(value,'$.evidence')) FROM json_each(json_extract(writingJobs.json,'$.checkIssues'))))) AS json FROM writingJobs WHERE json_extract(json,'$.projectId')=? ORDER BY rowid")
        .all(projectId).map(row => {
          const job = JSON.parse(String(row.json));
          const withoutEvidence = (issue: Record<string, unknown>) => ({ ...issue, evidence: [] });
          return { ...job, plan: "", issues: job.issues.map(withoutEvidence), checkIssues: job.checkIssues.map(withoutEvidence) };
        });
    }
    return { revision: this.generation, state, ...(chaptersUnchanged ? { chaptersUnchanged: true } : {}) };
  }
  revisionDetails(id: string, offset = 0, limit = 20): RevisionJob {
    const row = this.db.prepare("SELECT json_set(json_remove(json,'$.candidates','$.chapterSources','$.noteSources','$.referenceChapterSources','$.sourceProjectDigest','$.sourceProfileDigest'),'$.candidateCount',json_array_length(json,'$.candidates'),'$.candidatePendingCount',(SELECT count(*) FROM json_each(json_extract(revisionJobs.json,'$.candidates')) WHERE json_extract(value,'$.status')='pending')) AS json FROM revisionJobs WHERE id=?").get(id);
    if (!row) throw new DomainError("NOT_FOUND", "改稿任务不存在");
    const job = JSON.parse(String(row.json));
    job.candidateOffset = offset;
    job.candidates = this.db.prepare("SELECT value FROM revisionJobs,json_each(json_extract(revisionJobs.json,'$.candidates')) WHERE revisionJobs.id=? ORDER BY CAST(key AS INTEGER) LIMIT ? OFFSET ?")
      .all(id, limit, offset).map(r => JSON.parse(String(r.value)));
    return job as RevisionJob;
  }
  searchChapterText(projectId: string, query: string, offset = 0, limit = 40): SearchResult {
    const result: SearchResult = { matches: [], total: 0, nextOffset: null };
    if (!query) return result;
    const rows = this.db.prepare("SELECT json FROM chapters WHERE json_extract(json,'$.projectId')=? AND instr(json_extract(json,'$.content'),?)>0 ORDER BY json_extract(json,'$.ordinal')")
      .iterate(projectId, query);
    for (const row of rows) {
      const c = JSON.parse(String(row.json)) as Chapter;
      let at = c.content.indexOf(query);
      while (at >= 0) {
        if (result.total >= offset && result.matches.length < limit) result.matches.push({ chapterId: c.id, ordinal: c.ordinal, title: c.title, revision: c.revision, start: at, end: at + query.length, excerpt: c.content.slice(Math.max(0, at - 45), Math.min(c.content.length, at + query.length + 65)) });
        result.total++;
        at = c.content.indexOf(query, at + query.length);
      }
    }
    result.nextOffset = offset + result.matches.length < result.total ? offset + result.matches.length : null;
    return result;
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
