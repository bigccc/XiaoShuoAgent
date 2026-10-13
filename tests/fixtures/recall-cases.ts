import type { AppState, Chapter, Note } from "../../src/shared/types";

export const meta = { revision: 1, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" };
export function chapter(id: string, ordinal: number, content: string, extra: Partial<Chapter> = {}): Chapter {
  return { ...meta, id, projectId: "p", ordinal, title: id, content, status: "confirmed", needsReview: false, style: "", pace: "", ...extra };
}
export function state(chapters: Chapter[], notes: Note[] = []): AppState {
  return { schemaVersion: 5, projects: [{ ...meta, id: "p", title: "旧城", background: "", genre: "", style: "", pace: "", targetWords: 100000, chapterWords: 3000, archived: false }], chapters, notes, versions: [], conversations: [], materials: [], profiles: [], tasks: [], issues: [] };
}


export function recallCases() {
  return [
    { name: "remote-transfer", state: state([chapter("c8", 8, "阿宁把铜钥匙交给老周。"), chapter("c117", 117, "她望向窗外。"), chapter("c118", 118, "雨已经停了。"), chapter("c119", 119, "她走入大厅。")]), query: "铜钥匙在谁手中", beforeOrdinal: 120, relevant: ["c8"] },
    { name: "recent-and-remote", state: state([chapter("c8", 8, "铜钥匙交给老周。"), chapter("c117", 117, "阿宁回到旧城。"), chapter("c118", 118, "灯已经点亮。"), chapter("c119", 119, "老周收起铜钥匙。")]), query: "铜钥匙 老周", beforeOrdinal: 120, relevant: ["c8", "c119"] },
    { name: "irrelevant-control", state: state([chapter("c8", 8, "铜钥匙在老周手里。")]), query: "蓝宝石", beforeOrdinal: 120, relevant: [] },
    { name: "future-control", state: state([chapter("c121", 121, "铜钥匙在老周手里。")]), query: "铜钥匙", beforeOrdinal: 120, relevant: [] },
    { name: "draft-control", state: state([chapter("c8", 8, "铜钥匙在老周手里。", {status: "draft"})]), query: "铜钥匙", beforeOrdinal: 120, relevant: [] },
    { name: "stale-control", state: state([chapter("c8", 8, "铜钥匙在老周手里。", {needsReview: true})]), query: "铜钥匙", beforeOrdinal: 120, relevant: [] },
    { name: "foreign-control", state: state([chapter("c8", 8, "铜钥匙在老周手里。", {projectId: "other"})]), query: "铜钥匙", beforeOrdinal: 120, relevant: [] },
    { name: "alias", state: state([chapter("c8", 8, "小宁向老周告别。")], [{...meta, id:"n", projectId:"p", type:"character", title:"阿宁", body:"别名：小宁", sources:[], needsReview:false}]), query: "阿宁当时做了什么", beforeOrdinal: 120, relevant: ["c8"] },
    { name: "edited-source", state: state([chapter("c8", 8, "铜钥匙已归还阿宁。", {revision: 2})]), query: "铜钥匙", beforeOrdinal: 120, relevant: ["c8"] },
    { name: "generic-control", state: state([chapter("c8", 8, "故事正在继续。")]), query: "接着写一章", beforeOrdinal: 120, relevant: [] },
  ];
}
