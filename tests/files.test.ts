import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { ProjectFiles, readMaterialFile } from "../src/main/files";
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "novel-files-"));
  dirs.push(dir);
  const store = new Store(join(dir, "works.sqlite"));
  stores.push(store);
  const domain = new DomainService(store, {
    encryptKey: (s) => Buffer.from(`encrypted-${s}`),
  });
  const r = domain.execute({ type: "project.create", title: "中文测试小说" });
  if (!r.ok) throw Error();
  return { dir, store, domain, id: r.entityId, files: new ProjectFiles(store) };
}
function chapter(
  domain: DomainService,
  id: string,
  ordinal: number,
  content: string,
  confirmed = true,
) {
  const c = domain.execute({
    type: "chapter.create",
    projectId: id,
    ordinal,
    title: `第${ordinal}章`,
  });
  if (!c.ok) throw Error();
  const save = domain.execute({
    type: "chapter.save",
    id: c.entityId,
    revision: 1,
    content,
  });
  if (!save.ok) throw Error();
  if (confirmed)
    domain.execute({
      type: "chapter.confirm",
      id: c.entityId,
      revision: save.revision!,
    });
  return c.entityId;
}
describe("portable files", () => {
  it("exports ordered Chinese DOCX and TXT, excluding drafts by default", async () => {
    const { files, dir, id, domain } = setup();
    chapter(domain, id, 2, "后文 & <伏笔>");
    chapter(domain, id, 1, "前文😀\n第二行");
    chapter(domain, id, 3, "未确认草稿", false);
    const docx = join(dir, "novel.docx"),
      txt = join(dir, "novel.txt");
    await files.exportText(id, txt, false);
    await files.exportDocx(id, docx, false);
    const extracted = await readMaterialFile(docx);
    expect(extracted).toContain("前文😀\n第二行");
    expect(extracted).toContain("后文 & <伏笔>");
    expect(extracted.indexOf("第1章")).toBeLessThan(extracted.indexOf("第2章"));
    expect(extracted).not.toContain("未确认草稿");
    expect(readFileSync(txt, "utf8")).not.toContain("未确认草稿");
    await files.exportDocx(id, docx, true);
    expect(await readMaterialFile(docx)).toContain("未确认草稿");
  });
  it("roundtrips versions, linked material snapshots and remapped provenance without any profile or key", async () => {
    const { files, store, dir, id, domain } = setup();
    const cid = chapter(domain, id, 1, "已确认章节");
    const material = domain.execute({
      type: "material.save",
      materialType: "plot",
      title: "桥段",
      source: "原出处",
      content: "原桥段",
      explanation: "适用说明",
      approved: true,
    });
    if (!material.ok) throw Error();
    domain.execute({
      type: "material.link",
      id: material.entityId,
      revision: 1,
      projectId: id,
    });
    domain.execute({
      type: "material.save",
      id: material.entityId,
      revision: 2,
      materialType: "plot",
      title: "改后",
      source: "新出处",
      content: "新桥段",
      explanation: "修改",
      approved: true,
    });
    domain.execute({
      type: "profile.save",
      name: "私密配置",
      baseUrl: "https://example.test/v1",
      model: "m",
      purpose: "writing",
      apiKey: "TOP-SECRET",
    });
    const ch = store.get("chapters", cid)!;
    domain.execute({
      type: "note.save",
      projectId: id,
      noteType: "outline",
      title: "来源记录",
      body: "依据",
      sources: [{ kind: "chapter", id: cid, revision: ch.revision }],
    });
    const path = join(dir, "work.novel");
    await files.backup(id, path);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toMatch(
      /TOP-SECRET|encrypted|私密配置|profiles|credentials|ciphertext/i,
    );
    const copy = await files.importBackup(path);
    expect(copy).not.toBe(id);
    const state = domain.snapshot();
    expect(state.projects.find((p) => p.id === copy)?.title).toBe(
      "中文测试小说（副本）",
    );
    const imported = state.chapters.find((c) => c.projectId === copy)!;
    expect(imported.id).not.toBe(cid);
    expect(imported.content).toBe("已确认章节");
    expect(state.versions.filter((v) => v.projectId === copy)).toHaveLength(3);
    expect(state.notes.find((n) => n.projectId === copy)?.sources[0].id).toBe(
      imported.id,
    );
    expect(
      state.materials.find((m) =>
        m.projectReferences.some((r) => r.projectId === copy),
      )?.projectReferences[0].snapshot.content,
    ).toBe("原桥段");
    expect(state.profiles).toHaveLength(1);
  });
  it("rejects tampering and invalid reference packages before any mutation", async () => {
    const { files, dir, id, domain } = setup();
    chapter(domain, id, 1, "原文");
    const path = join(dir, "package.novel");
    await files.backup(id, path);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace("原文", "篡改"));
    await expect(files.importBackup(path)).rejects.toThrow(/校验/);
    expect(domain.snapshot().projects).toHaveLength(1);
  });
  it("rejects unsupported .doc, invalid UTF8 and oversized source text", async () => {
    const { dir } = setup();
    const doc = join(dir, "old.doc");
    writeFileSync(doc, "old");
    await expect(readMaterialFile(doc)).rejects.toThrow(/docx/);
    const txt = join(dir, "bad.txt");
    writeFileSync(txt, Buffer.from([0xff, 0xfe, 0x01]));
    await expect(readMaterialFile(txt)).rejects.toThrow(/编码/);
    writeFileSync(txt, "a".repeat(2_000_001));
    await expect(readMaterialFile(txt)).rejects.toThrow(/大小|长度/);
  });
});
