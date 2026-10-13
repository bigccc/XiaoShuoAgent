import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { ProjectFiles } from "../src/main/files";

const directory = mkdtempSync(join(tmpdir(), "novel-scale-backup-"));
const store = new Store(join(directory, "scale.sqlite"));
try {
  const created = new DomainService(store).execute({
    type: "project.create",
    title: "五千章持久化验证",
  });
  if (!created.ok) throw Error(created.error.message);
  const projectId = created.entityId,
    now = new Date().toISOString();
  const text = "山河风雨".repeat(750),
    old = "旧日故事".repeat(750);
  store.transaction(() => {
    for (let i = 1; i <= 5000; i++) {
      store.put("chapters", {
        id: `chapter-${i}`,
        projectId,
        ordinal: i,
        title: `第${i}章`,
        content: text,
        status: "draft",
        needsReview: false,
        style: "",
        pace: "",
        revision: 2,
        createdAt: now,
        updatedAt: now,
      });
      for (let v = 1; v <= 2; v++)
        store.put("versions", {
          id: `version-${i}-${v}`,
          chapterId: `chapter-${i}`,
          projectId,
          chapterRevision: v,
          title: `第${i}章`,
          content: v === 1 ? old : text,
          style: "",
          pace: "",
          status: "draft",
          reason: v === 1 ? "create" : "save",
          createdAt: now,
          sourceRevisions: [],
        });
    }
  });
  const start = performance.now(),
    snapshot = store.workspaceSnapshot(projectId);
  const snapshotMs = Math.round(performance.now() - start),
    snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const files = new ProjectFiles(store),
    path = join(directory, "large.novel");
  let at = performance.now();
  await files.backup(projectId, path);
  const backupMs = Math.round(performance.now() - at),
    backupBytes = statSync(path).size;
  at = performance.now();
  const copyId = await files.importBackup(path);
  const importMs = Math.round(performance.now() - at);
  const chapters = store.chapterMetadata(copyId),
    versions = store.selectByProject("versions", copyId);
  if (
    chapters.length !== 5000 ||
    versions.length !== 10000 ||
    store.get("chapters", chapters[4999].id)?.content !== text ||
    versions[0].content !== old
  )
    throw Error("大规模备份恢复数据校验失败");
  console.log(
    JSON.stringify(
      {
        chapters: chapters.length,
        proseCharacters: 15_000_000,
        historicalCopies: 2,
        snapshotBytes,
        snapshotMs,
        backupBytes,
        backupMs,
        importMs,
        importedVersions: versions.length,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
