import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
let app: ElectronApplication, page: Page, dir: string;
async function launch() {
  app = await electron.launch({
    args: [
      process.env.NOVEL_PACKAGED_EXECUTABLE ? "" : "out/main/index.js",
    ].filter(Boolean),
    executablePath: process.env.NOVEL_PACKAGED_EXECUTABLE,
    env: { ...process.env, NOVEL_TEST: "1", NOVEL_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
}
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "novel-desktop-"));
  await launch();
});
test.afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
// A missing flush/save or wrong revision loses edits across immediate navigation/restart.
test("author edits persist across navigation, confirmation, history and restart", async () => {
  await expect(page.getByText("你的下一部故事，从这里开始")).toBeVisible();
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByLabel("作品名称").fill("纸上的星河");
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
  await page
    .getByLabel("简介与背景", { exact: true })
    .fill("山城少年与回声列车。");
  await page.getByRole("button", { name: "人物与世界", exact: true }).click();
  await page.getByRole("button", { name: "新建设定", exact: true }).click();
  await page.getByLabel("设定标题").fill("林舟");
  await page.getByLabel("设定正文").fill("林舟十七岁，怕黑，习惯轻声说话。");
  await page.getByRole("button", { name: "正文与版本", exact: true }).click();
  await page.getByRole("button", { name: "新建章节", exact: true }).click();
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("第一夜，林舟在站台听见自己的回声。");
  await page.getByRole("button", { name: "确认正文", exact: true }).click();
  await expect(page.getByText("已确认", { exact: true }).first()).toBeVisible();
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("第二夜，林舟走进列车。");
  await page.getByRole("button", { name: "历史版本", exact: true }).click();
  await expect(
    page
      .getByText("第一夜，林舟在站台听见自己的回声。", { exact: true })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "恢复此版本", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "第一夜，林舟在站台听见自己的回声。",
  );
  await app.close();
  await launch();
  await page.getByRole("button", { name: /打开 纸上的星河/ }).click();
  await expect(page.getByLabel("简介与背景", { exact: true })).toHaveValue(
    "山城少年与回声列车。",
  );
  await page.getByRole("button", { name: "人物与世界", exact: true }).click();
  await expect(page.getByLabel("设定正文")).toHaveValue(
    "林舟十七岁，怕黑，习惯轻声说话。",
  );
  await page.getByRole("button", { name: "正文与版本", exact: true }).click();
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "第一夜，林舟在站台听见自己的回声。",
  );
  await page.screenshot({ path: "test-results/chapter-editor.png" });
});
// A fake generated response, automatic adoption or broken typed IPC would fail this workflow.
test("real local provider creates reviewed AI candidate without replacing author draft", async () => {
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const body = JSON.parse(text);
    const prompt = JSON.stringify(body.messages);
    const output = prompt.includes("JSON")
      ? JSON.stringify({ issues: [], majorChange: false })
      : "风从古城吹来，林舟握紧车票。";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: output } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page
      .getByRole("button", { name: "新增模型", exact: true })
      .first()
      .click();
    await page.getByLabel("配置名称").fill("本地验收");
    await page
      .getByLabel("API 地址")
      .fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel("模型名称").fill("fixture");
    await page.getByLabel("API 密钥").fill("fixture-only");
    await page.getByRole("button", { name: "保存模型", exact: true }).click();
    await expect(page.getByText("已安全保存密钥")).toBeVisible();
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(page.getByText("连接成功")).toBeVisible();
    await page.getByRole("button", { name: "书架", exact: true }).click();
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.getByLabel("作品名称").fill("列车");
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await page.getByRole("button", { name: "新建章节", exact: true }).click();
    await page.getByLabel("章节正文", { exact: true }).fill("作者保留的草稿。");
    await page
      .getByRole("button", { name: "生成选中章节", exact: true })
      .click();
    await expect(
      page.getByText("风从古城吹来，林舟握紧车票。", { exact: true }).first(),
    ).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: "test-results/task-review.png" });
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "作者保留的草稿。",
    );
    await page.getByRole("button", { name: "任务与审阅", exact: true }).click();
    await page.getByRole("button", { name: "采用为草稿", exact: true }).click();
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "风从古城吹来，林舟握紧车票。",
    );
    await page.screenshot({ path: "test-results/ai-review.png" });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
async function createWork(title = "验收小说") {
  await page.getByRole("button", { name: "书架", exact: true }).click();
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
}
async function configure(url: string) {
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page
    .getByRole("button", { name: "新增模型", exact: true })
    .first()
    .click();
  await page.getByLabel("配置名称").fill("验收模型");
  await page.getByLabel("API 地址").fill(url);
  await page.getByLabel("模型名称").fill("fixture");
  await page.getByLabel("API 密钥").fill("fixture-secret-not-production");
  await page.getByRole("button", { name: "保存模型", exact: true }).click();
  await expect(page.getByText("已安全保存密钥")).toBeVisible();
}
async function localProvider(reply: (body: any) => string | Promise<string>) {
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const c of req) input += c;
    const body = JSON.parse(input);
    const content = await reply(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
// Lost UI wiring, auto-promotion, missing provenance or wrong issue status fails this real workflow.
test("planning, materials, source evidence, export and backup work through visible controls", async () => {
  const provider = await localProvider((body) => {
    const system = body.messages[0].content,
      user = body.messages.map((m: any) => m.content).join("\n");
    if (system.includes("materials"))
      return JSON.stringify({
        materials: [
          {
            type: "plot",
            title: "误会转折",
            content: "先误解再澄清。",
            explanation: "适合轻喜剧，勿滥用。",
          },
        ],
      });
    if (system.includes("issues")) {
      const match = user.match(/\[chapter:([^@]+)@(\d+)[^\]]*\]/);
      return JSON.stringify({
        issues: match
          ? [
              {
                type: "timeline",
                reason: "时间记录需要核对",
                evidence: [
                  {
                    quote: "林舟十七岁。",
                    source: {
                      kind: "chapter",
                      id: match[1],
                      revision: Number(match[2]),
                    },
                  },
                ],
              },
            ]
          : [],
        majorChange: false,
      });
    }
    return "第一幕：误会相遇；第二幕：回声揭示真相。";
  });
  try {
    await configure(provider.url);
    await createWork("流程验收");
    await page.getByLabel("简介与背景", { exact: true }).fill("山城回声列车。");
    await page
      .getByRole("button", { name: "生成规划建议", exact: true })
      .click();
    await expect(page.getByLabel("可编辑的规划建议")).toHaveValue(
      "第一幕：误会相遇；第二幕：回声揭示真相。",
    );
    await page
      .getByRole("button", { name: "采纳为新设定", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "已保存为设定", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "故事规划", exact: true }).click();
    await expect(page.getByLabel("设定正文")).toHaveValue(
      "第一幕：误会相遇；第二幕：回声揭示真相。",
    );
    await page
      .getByRole("button", { name: "素材库", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "粘贴新素材", exact: true }).click();
    await page.getByLabel("素材标题").fill("站台表达");
    await page.getByLabel("原始来源").fill("作者自创");
    await page.getByLabel("素材内容").fill("回声会记住一个人。");
    await page.getByLabel("适用条件与局限").fill("适用于回声设定。");
    await page.getByLabel("我已阅读并审核此素材").check();
    await page.getByRole("button", { name: "保存素材", exact: true }).click();
    await page.getByRole("button", { name: "引用到本作", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "取消本作引用", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "展开上下文与批量设置 ↓", exact: true })
      .click();
    await page.getByLabel("提取来源备注").fill("作者练习原文");
    await page
      .getByLabel("待提取原文")
      .fill("两人认错了车票，误解之后才知道真相。");
    await page
      .getByRole("button", { name: "提取素材候选", exact: true })
      .click();
    await expect(page.getByLabel("素材标题")).toHaveValue("误会转折");
    await page.getByLabel("我已阅读并审核此素材").check();
    await page.getByRole("button", { name: "保存素材", exact: true }).click();
    await expect(page.getByText("已保存素材", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await page.getByRole("button", { name: "新建章节", exact: true }).click();
    await page.getByLabel("章节正文", { exact: true }).fill("林舟十七岁。");
    await page.getByRole("button", { name: "确认正文", exact: true }).click();
    await page
      .getByRole("button", { name: "检查已确认正文", exact: true })
      .click();
    await expect(
      page.getByText("时间记录需要核对", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "一致性检查", exact: true }).click();
    await expect(page.locator("blockquote")).toContainText("林舟十七岁。");
    await page
      .getByRole("button", { name: "已修改，标记处理", exact: true })
      .click();
    await page.getByRole("button", { name: "已处理", exact: true }).click();
    await expect(
      page.getByText("时间记录需要核对", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    const inputPath = join(dir, "import.txt");
    await writeFile(inputPath, "导入的中文素材。");
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, inputPath);
    await page.getByLabel("导入来源备注").fill("本地验收文件");
    await page
      .getByRole("button", { name: "导入 TXT／DOCX", exact: true })
      .click();
    await expect(page.getByLabel("素材内容")).toHaveValue("导入的中文素材。");
    await expect(page.getByLabel("我已阅读并审核此素材")).not.toBeChecked();
    const txt = join(dir, "novel.txt"),
      docx = join(dir, "novel.docx"),
      backup = join(dir, "novel.novel");
    await app.evaluate(
      ({ dialog }, paths) => {
        let index = 0;
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: paths[index++],
        })) as typeof dialog.showSaveDialog;
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [paths[2]],
        })) as typeof dialog.showOpenDialog;
      },
      [txt, docx, backup],
    );
    await page.getByRole("button", { name: "导出与备份", exact: true }).click();
    await page.getByRole("button", { name: "导出 TXT", exact: true }).click();
    await expect(
      page.getByText("正文已导出到所选位置。", { exact: true }),
    ).toBeVisible();
    expect(await readFile(txt, "utf8")).toContain("林舟十七岁。");
    await page
      .getByRole("button", { name: "导出 Word（DOCX）", exact: true })
      .click();
    await expect
      .poll(async () => (await readFile(docx)).subarray(0, 2).toString())
      .toBe("PK");
    await page
      .getByRole("button", { name: "备份完整作品", exact: true })
      .click();
    await expect(
      page.getByText("完整作品备份已保存到所选位置。", { exact: true }),
    ).toBeVisible();
    const contents = await readFile(backup, "utf8");
    expect(contents).not.toContain("fixture-secret-not-production");
    expect(contents).toContain("站台表达");
    await page
      .getByRole("button", { name: "导入作品／恢复备份", exact: true })
      .click();
    await expect(
      page.getByText("备份已导入为独立副本，请在书架打开。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "书架", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /打开 流程验收/ }),
    ).toHaveCount(2);
    await page.screenshot({ path: "test-results/bookcase.png" });
    const malformed = join(dir, "bad.novel");
    await writeFile(malformed, "{}");
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, malformed);
    await page
      .getByRole("button", { name: "导入作品备份", exact: true })
      .click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /打开 流程验收/ }),
    ).toHaveCount(2);
  } finally {
    await provider.close();
  }
});
// Polls must not discard dirty text; save conflicts must block navigation and orderly close must flush.
test("dirty edits survive polling, pending close and a real revision conflict", async () => {
  await createWork("保存验收");
  await page.getByRole("button", { name: "正文与版本", exact: true }).click();
  await page.getByRole("button", { name: "新建章节", exact: true }).click();
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("关闭前仍待保存的文字。");
  await app.close();
  await launch();
  await page.getByRole("button", { name: /打开 保存验收/ }).click();
  await page.getByRole("button", { name: "正文与版本", exact: true }).click();
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "关闭前仍待保存的文字。",
  );
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("作者尚未保存的修改。");
  await page.evaluate(async () => {
    const chapter = (await window.novel.snapshot()).chapters[0];
    await window.novel.invoke({
      type: "chapter.save",
      id: chapter.id,
      revision: chapter.revision,
      content: "另一条本机修改。",
    });
  });
  await page.getByRole("button", { name: "人物与世界", exact: true }).click();
  await expect(
    page.getByText("保存失败，内容仍在编辑器中", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "作者尚未保存的修改。",
  );
  await page
    .getByRole("button", { name: "放弃编辑并重新载入", exact: true })
    .click();
  await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
    "另一条本机修改。",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 680),
  );
  await page.screenshot({ path: "test-results/minimum-window.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "确认正文", exact: true }),
  ).toBeVisible();
});
// Invalid/unapproved batch must make no provider call; approved contiguous batch stays as candidates.
test("explicit batch generation, cancellation and continuation retain reviewed candidates", async () => {
  let writing = 0;
  const provider = await localProvider(async (body) => {
    const system = body.messages[0].content;
    if (system.includes("issues"))
      return JSON.stringify({ issues: [], majorChange: false });
    writing++;
    await new Promise((r) => setTimeout(r, 300));
    return `第${writing}次的候选正文，车票指向山城。`;
  });
  try {
    await configure(provider.url);
    await createWork("批量验收");
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    for (let i = 0; i < 3; i++)
      await page.getByRole("button", { name: "新建章节", exact: true }).click();
    await page
      .getByRole("button", { name: "展开上下文与批量设置 ↓", exact: true })
      .click();
    for (let i = 1; i <= 3; i++)
      await page.getByLabel(`${i}. 第${i}章`, { exact: true }).first().check();
    await page
      .getByRole("button", { name: "生成选中章节", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("授权");
    expect(writing).toBe(0);
    await page.getByLabel("我授权本次连续生成 3—5 章").check();
    await page
      .getByRole("button", { name: "生成选中章节", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "取消任务", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(
      page.getByText("已取消", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "继续任务", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "采用为草稿", exact: true }),
    ).toHaveCount(3, { timeout: 20000 });
    await expect(
      page.getByText("待作者处理", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/batch-review.png" });
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue("");
  } finally {
    await provider.close();
  }
});
// Stale suggestions must require explicit author review before attaching current source revisions.
test("changed-source planning and generation require explicit review", async () => {
  const provider = await localProvider((body) =>
    body.messages[0].content.includes("issues")
      ? JSON.stringify({ issues: [], majorChange: false })
      : "林舟听见了新的回声。",
  );
  try {
    await configure(provider.url);
    await createWork("来源复核");
    await page.getByLabel("简介与背景", { exact: true }).fill("旧背景");
    await page
      .getByRole("button", { name: "生成规划建议", exact: true })
      .click();
    await expect(page.getByLabel("可编辑的规划建议")).toHaveValue(
      "林舟听见了新的回声。",
    );
    await page.getByRole("button", { name: "创意与风格", exact: true }).click();
    await page.getByLabel("简介与背景", { exact: true }).fill("修改后的背景");
    await page.getByRole("button", { name: "任务与审阅", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "采纳为新设定", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("我已对照当前来源审核这份规划").check();
    await page.evaluate(async () => {
      const p = (await window.novel.snapshot()).projects[0];
      await window.novel.invoke({
        type: "project.update",
        id: p.id,
        revision: p.revision,
        patch: { background: "复核后的另一次变更" },
      });
    });
    await expect(
      page.getByRole("button", { name: "采纳为新设定", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("我已对照当前来源审核这份规划").check();
    await page
      .getByRole("button", { name: "采纳为新设定", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "已保存为设定", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await page.getByRole("button", { name: "新建章节", exact: true }).click();
    await page
      .getByRole("button", { name: "生成选中章节", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "采用为草稿", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "创意与风格", exact: true }).click();
    await page.getByLabel("简介与背景", { exact: true }).fill("第三版背景");
    await page.getByRole("button", { name: "任务与审阅", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "采用为草稿", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("我已对照变化后的来源复核此候选").check();
    await page.getByRole("button", { name: "采用为草稿", exact: true }).click();
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await expect(page.getByLabel("章节正文", { exact: true })).toHaveValue(
      "林舟听见了新的回声。",
    );
  } finally {
    await provider.close();
  }
});
// Navigating away from manually saved model/material forms must not silently discard typed data.
test("unsaved material asks to save before leaving", async () => {
  await createWork("素材保存");
  await page.getByRole("button", { name: "素材库", exact: true }).click();
  await page.getByRole("button", { name: "粘贴新素材", exact: true }).click();
  await page.getByLabel("素材标题").fill("未保存的灵感");
  await page.getByLabel("原始来源").fill("作者笔记");
  await page.getByLabel("素材内容").fill("窗外的雨倒着走。");
  await page.getByRole("button", { name: "正文与版本", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "尚有未保存的修改" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存后离开", exact: true }).click();
  await page.getByRole("button", { name: "素材库", exact: true }).click();
  await page.getByRole("button", { name: /未保存的灵感/ }).click();
  await expect(page.getByLabel("素材内容")).toHaveValue("窗外的雨倒着走。");
});

test("isolated renderer rejects a second window sender and has no Node or credential read API", async () => {
  expect(
    await page.evaluate(() => ({
      node: typeof (window as any).require,
      keys: Object.keys(window.novel).sort(),
    })),
  ).toEqual({
    node: "undefined",
    keys: ["closeReady", "invoke", "onBeforeClose", "snapshot"],
  });
  expect(
    await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      const rogue = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: decodeURIComponent(
            new URL("../preload/index.cjs", main.webContents.getURL()).pathname,
          ),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      await rogue.loadURL(main.webContents.getURL());
      const rejected = await rogue.webContents.executeJavaScript(
        "window.novel.snapshot().then(()=>false,()=>true)",
      );
      rogue.destroy();
      return rejected;
    }),
  ).toBe(true);
});

test("streaming cancellation retains partial text and continues through the actual UI", async () => {
  let writes = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (body.messages[0].content.includes("issues")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ issues: [], majorChange: false }),
              },
            },
          ],
        }),
      );
      return;
    }
    const first = ++writes === 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: {
                content: first ? "尚未完成的片段。" : "续写：回声再次响起。",
              },
            },
          ],
        }) +
        "\n\n",
    );
    const timer = setTimeout(
      () =>
        res.end(
          "data: " +
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        ),
      first ? 5000 : 200,
    );
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await configure(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await createWork("流式验收");
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await page.getByRole("button", { name: "新建章节", exact: true }).click();
    await page
      .getByRole("button", { name: "生成选中章节", exact: true })
      .click();
    await expect(
      page.getByText("尚未完成的片段。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(
      page.getByText("已取消", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("尚未完成的片段。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "继续任务", exact: true }).click();
    await expect(
      page.getByText("尚未完成的片段。续写：回声再次响起。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "采用为草稿", exact: true }),
    ).toBeEnabled();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("offline startup and editing do not initialize an unavailable Keychain", async () => {
  test.skip(
    !!process.env.NOVEL_PACKAGED_EXECUTABLE,
    "Test-only bootstrap imports the actual compiled main; packaged startup is verified separately without interception.",
  );
  await app.close();
  const observed = join(dir, "keychain-access.txt");
  app = await electron.launch({
    args: [join(process.cwd(), "tests/e2e/keychain-unavailable.cjs")],
    env: {
      ...process.env,
      NOVEL_TEST: "1",
      NOVEL_DATA_DIR: dir,
      NOVEL_KEYCHAIN_OBSERVATION: observed,
    },
  });
  try {
    page = await app.firstWindow({ timeout: 5000 });
    await expect(page.getByText("你的下一部故事，从这里开始")).toBeVisible();
    expect(await readFile(observed, "utf8").catch(() => "")).toBe("");
    await createWork("离线钥匙串验收");
    await page
      .getByLabel("简介与背景", { exact: true })
      .fill("钥匙串不可用也能写作。");
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await page.getByRole("button", { name: "新建章节", exact: true }).click();
    await page.getByLabel("章节正文", { exact: true }).fill("作者的离线文字。");
    await page.getByRole("button", { name: "确认正文", exact: true }).click();
    expect(await readFile(observed, "utf8").catch(() => "")).toBe("");
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page
      .getByRole("button", { name: "新增模型", exact: true })
      .first()
      .click();
    await page.getByLabel("配置名称").fill("受保护配置");
    await page.getByLabel("API 地址").fill("https://example.invalid/v1");
    await page.getByLabel("模型名称").fill("fixture");
    await page.getByLabel("API 密钥").fill("must-never-be-plaintext");
    await page.getByRole("button", { name: "保存模型", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("密钥");
    expect(
      (await page.evaluate(() => window.novel.snapshot())).profiles,
    ).toHaveLength(0);
    expect(await readFile(observed, "utf8")).toBe("isEncryptionAvailable\n");
    await page.getByLabel("API 密钥").fill("");
    await page.getByRole("button", { name: "保存模型", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "测试连接", exact: true }),
    ).toBeVisible();
  } catch (error) {
    app.process().kill("SIGKILL");
    throw error;
  }
});

test("planning edits are guarded across task switch, navigation and close until explicit adoption", async () => {
  const provider = await localProvider(() => "原始规划建议。");
  try {
    await configure(provider.url);
    await createWork("规划审阅保护");
    await page
      .getByRole("button", { name: "生成规划建议", exact: true })
      .click();
    await expect(page.getByLabel("可编辑的规划建议")).toHaveValue(
      "原始规划建议。",
    );
    await page
      .getByRole("button", { name: "生成规划建议", exact: true })
      .click();
    await expect(page.locator("main .item-list button")).toHaveCount(2);
    await page.locator("main .item-list button").nth(1).click();
    await page.getByLabel("建议标题").fill("作者审阅后的故事线");
    await page
      .getByLabel("可编辑的规划建议")
      .fill("作者修改：林舟决定留在山城。");
    await page.locator("main .item-list button").nth(0).click();
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/planning-edit-guard.png" });
    await page.getByRole("button", { name: "返回编辑", exact: true }).click();
    await expect(page.getByLabel("可编辑的规划建议")).toHaveValue(
      "作者修改：林舟决定留在山城。",
    );
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回编辑", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回编辑", exact: true }).click();
    expect(
      (await page.evaluate(() => window.novel.snapshot())).notes,
    ).toHaveLength(0);
    await page.locator("main .item-list button").nth(0).click();
    await page
      .getByRole("button", { name: "采纳为新设定并离开", exact: true })
      .click();
    await expect(page.getByLabel("可编辑的规划建议")).toHaveValue(
      "原始规划建议。",
    );
    await page.getByRole("button", { name: "故事规划", exact: true }).click();
    await expect(page.getByLabel("设定标题")).toHaveValue("作者审阅后的故事线");
    await expect(page.getByLabel("设定正文")).toHaveValue(
      "作者修改：林舟决定留在山城。",
    );
  } finally {
    await provider.close();
  }
});

test("every extraction candidate form is guarded without automatically approving material", async () => {
  const provider = await localProvider((body) =>
    body.messages[0].content.includes("materials")
      ? JSON.stringify({
          materials: [
            {
              type: "expression",
              title: "第一个候选",
              content: "初始表达。",
              explanation: "候选一条件。",
            },
            {
              type: "plot",
              title: "第二个候选",
              content: "初始桥段。",
              explanation: "候选二条件。",
            },
          ],
        })
      : "原始规划建议。",
  );
  try {
    await configure(provider.url);
    await createWork("多候选保护");
    await page
      .getByRole("button", { name: "生成规划建议", exact: true })
      .click();
    await expect(page.getByLabel("可编辑的规划建议")).toHaveValue(
      "原始规划建议。",
    );
    await page
      .getByRole("button", { name: "展开上下文与批量设置 ↓", exact: true })
      .click();
    await page.getByLabel("提取来源备注").fill("作者原文");
    await page.getByLabel("待提取原文").fill("灵感材料。");
    await page
      .getByRole("button", { name: "提取素材候选", exact: true })
      .click();
    await expect(page.getByLabel("素材内容")).toHaveCount(2);
    await page.getByLabel("素材内容").nth(0).fill("作者修改的表达。");
    await page.getByLabel("我已阅读并审核此素材").nth(0).check();
    await page.getByLabel("素材内容").nth(1).fill("作者修改的桥段。");
    await page.locator("main .item-list button").nth(1).click();
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "保存后离开", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toContainText("第二个候选");
    await page.screenshot({ path: "test-results/extraction-edit-guard.png" });
    await page.getByRole("button", { name: "返回编辑", exact: true }).click();
    await expect(page.getByLabel("素材内容").nth(1)).toHaveValue(
      "作者修改的桥段。",
    );
    expect(
      (await page.evaluate(() => window.novel.snapshot())).materials,
    ).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回编辑", exact: true }).click();
    await page.getByRole("button", { name: "正文与版本", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "尚有未保存的修改" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "保存后离开", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "新建章节", exact: true }),
    ).toBeVisible();
    const materials = (await page.evaluate(() => window.novel.snapshot()))
      .materials;
    expect(materials).toHaveLength(2);
    expect(materials.find((m) => m.title === "第一个候选")).toMatchObject({
      content: "作者修改的表达。",
      approved: true,
    });
    expect(materials.find((m) => m.title === "第二个候选")).toMatchObject({
      content: "作者修改的桥段。",
      approved: false,
    });
  } finally {
    await provider.close();
  }
});
