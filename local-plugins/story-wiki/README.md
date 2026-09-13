# 剧情库检索（story-wiki）

让 Cyrene 检索本地《崩坏：星穹铁道》剧情库的运行时插件。
引擎移植自 Castorice-Agent 的 `search_story` 工具与 `story-wiki` 数据层。

## 功能

- 注册 Agent 工具 `story-wiki_search`：问剧情细节、角色背景、NPC 对话、任务内容、
  台词核对时，Cyrene 先查官方原文再作答，防止记混或编造
- 检索范围：角色 / NPC / 书籍 / 开拓任务 / 同行任务 / 开拓续闻 / 冒险任务 / 角色语音 / 光锥
- 多关键词加权（标题命中 > 正文命中，全部命中更靠前）；BWiki 模板自动清洗成可读文本
- 数据目录可视化配置（设置弹窗选择），并自动探测常见位置

## 数据来源

开源项目 [HSRChat](https://github.com/XCreeperPa/HSRChat)（MIT，作者 XCreeperPa），
克隆仓库后使用其中的 `references/wiki` 目录（约 1600 个 .txt / 18MB）：

```bash
git clone https://github.com/XCreeperPa/HSRChat.git
```

## 安装

1. ZIP 导入：聊天窗口 → 插件 → 添加 → 选 `story-wiki-0.1.0.zip`；
   或把 `story-wiki` 文件夹复制到 `%APPDATA%\live2d-cyrene\plugins\`
2. 插件面板点「启用」
3. 点「打开」→ 「选择数据目录」→ 选 HSRChat 的 `references/wiki`

## 验证

对 Cyrene 说「查一下遐蝶在哀地里亚的剧情」「白厄的开拓任务原文是什么」，确认她调用
「剧情库检索」工具并基于原文回答。

## 文件

| 文件 | 说明 |
|---|---|
| `manifest.json` | 插件清单（apiVersion 1，无 deps） |
| `index.cjs` | 索引构建、BWiki 清洗、加权检索、目录配置 IPC |
| `ui.html` | 设置弹窗（数据目录选择 + 索引状态/分类展示） |
| `cyrene-theme.css` | 主程序 pearl-white 主题样式 |
