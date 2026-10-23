import { viewAuthorStage } from "./support/author-navigation";
import {
  _electron as electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { normalizationReply } from "./support/sync-fixture";
let app: ElectronApplication, page: Page, dir: string;
async function launch() {
  app = await electron.launch({
    args: [...(process.env.NOVEL_PACKAGED_EXECUTABLE ? [] : ["out/main/index.js"]), "--use-mock-keychain"],
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
}
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-stages-ui-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
const documents = {
  overview:
    "故事概要：寄给自己的遗物\n\n遗物整理师林舟收到一个包裹，里面是十年后属于自己的遗物。为了查明寄件人，他沿着一份失踪名单调查。\n\n关键转折：父亲并未失踪，而是参与了制造这些包裹的骗局。\n\n结局方向：林舟公开骗局，也接受父亲的过错；他从替别人收拾过去，走向决定自己的未来。",
  settings:
    "主要人物\n林舟：遗物整理师，嘴贫、怕黑，擅长从物品细节还原生活。\n林父：骗局参与者，试图用谎言保护儿子。\n\n背景与规则\n现代沿海小城；包裹来自现实中的人，没有时间旅行。\n\n基调\n轻松对话推动悬疑，父子关系通过行动展开。",
  outline:
    "全书主线\n收到遗物 → 追查名单 → 发现父亲 → 拆穿骗局 → 重建关系。\n\n近期三章\n第一章：林舟收到包裹，发现一件只有自己认识的物品。\n第二章：寄件人现身，却否认寄出包裹。\n第三章：失踪名单上出现父亲的旧名字。",
};
test("visible stage progression, editable upstream artifacts and restart retain real confirmations", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const normalized = normalizationReply(JSON.parse(raw));
    if (!normalized) calls++;
    const stage = calls === 1 ? "overview" : undefined;
    const output = normalized ?? (stage
      ? {
          message: `已准备好${{ overview: "故事概要", settings: "必要设定", outline: "故事大纲" }[stage]}，请整体看看。`,
          artifacts: [{ stage, content: documents[stage] }],
        }
      : calls === 2
        ? { message: "人物和大纲已准备，请整体确认。", artifacts: [{ stage: "settings", content: documents.settings }, { stage: "outline", content: documents.outline }] }
      : calls === 3
        ? {
            message: "第一章试写已保存。",
            chapters: [
              {
                title: "包裹",
                content: "林舟收到自己的遗物，第一反应是快递员送错了年代。",
                stage: "opening",
              },
            ],
          }
        : {
            message: "已将新的调查方向同步到设定与大纲，前文未改。",
            artifacts: ["overview", "settings", "outline"].map((stage) => ({
              stage,
              content: `新的调查骗局方向：${stage}`,
            })),
          });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await page.evaluate(
      async (baseUrl) => {
        await window.novel.invoke({
          type: "profile.save", pricing: { currency: "CNY", input: 0, output: 0 },
          name: "阶段验收",
          baseUrl,
          model: "fixture",
          purpose: "writing",
        });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "定故事", exact: true }),
    ).toBeVisible();
    await page.getByLabel("创作消息").fill("我想写一个有温情的悬疑故事");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByLabel("概要成果")).toHaveValue(documents.overview);
    await page.screenshot({ path: "test-results/staged-overview.png" });
    await page.getByRole("button", { name: "确认方向，做准备", exact: true }).click();
    await expect(page.getByLabel("大纲成果")).toHaveValue(documents.outline);
    await viewAuthorStage(page, "设定");
    await expect(page.getByLabel("设定成果")).toHaveValue(documents.settings);
    expect(
      (await page.evaluate(() => window.novel.snapshot())).projects[0]
        .authoring!.documents.overview!.approved,
    ).toBe(true);
    await viewAuthorStage(page, "大纲");
    await expect(page.getByLabel("大纲成果")).toHaveValue(documents.outline);
    await page.screenshot({ path: "test-results/staged-outline.png" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1050, 680),
    );
    await page.screenshot({ path: "test-results/staged-minimum.png" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.getByRole("button", { name: "按推荐继续", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      /快递员/,
    );
    await viewAuthorStage(page, "概要");
    expect(
      (await page.evaluate(() => window.novel.snapshot())).projects[0]
        .authoring!.activeStage,
    ).toBe("writing");
    await page
      .getByLabel("概要成果")
      .fill("手动调整：从寻找失踪父亲改为调查父亲留下的骗局。");
    await page.getByLabel("创作消息").fill("请同步受影响的设定和大纲");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByLabel("概要成果")).toHaveValue(
      "新的调查骗局方向：overview",
    );
    const state = await page.evaluate(() => window.novel.snapshot());
    expect(state.projects[0].authoring!.reviewGroup).toEqual([
      "overview",
      "settings",
      "outline",
    ]);
    expect(state.chapters[0].content).toContain("快递员");
    await app.close();
    await launch();
    await page.getByRole("button", { name: "打开 未命名故事" }).click();
    await expect(page.getByLabel("概要成果")).toHaveValue(
      "新的调查骗局方向：overview",
    );
    await page.getByText("成果历史", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "恢复这份成果" }),
    ).toBeVisible();
  } finally {
    await new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  }
});
