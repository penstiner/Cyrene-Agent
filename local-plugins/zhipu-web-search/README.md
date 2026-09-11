# 智谱网络搜索（zhipu-web-search）

让 Cyrene 在对话中联网搜索实时信息的运行时插件，基于智谱开放平台 web_search API。
工具实现移植自 Castorice-Agent 的 `search_web` 内置工具。

## 功能

- 注册 Agent 工具 `zhipu-web-search_search`：Cyrene 在用户问新闻、百科、实时事件，
  或说「帮我查一下」时自动调用
- 支持时间范围过滤（当天 / 一周 / 一月 / 一年）与返回条数（1-10）
- API Key 存放在系统级安全存储中（插件命名空间隔离），不出现在对话与日志里
- 插件卡片「打开」按钮弹出设置窗口，可视化配置 / 清除 Key

## 安装

1. 把 `zhipu-web-search.zip` 通过 聊天窗口 → 插件 → 右上角添加 导入；
   或将 `zhipu-web-search` 文件夹复制到
   `%APPDATA%\live2d-cyrene\plugins\`
2. 在插件面板点击「启用」
3. 点插件卡片的「打开」，粘贴智谱 API Key 并保存
   （Key 在 [open.bigmodel.cn](https://open.bigmodel.cn) 的 API Keys 页面创建）

## 验证

对 Cyrene 说「帮我搜一下今天的新闻」，确认她调用「网络搜索」工具并转述结果；
插件卡片状态应为 `running`。

## 文件

| 文件 | 说明 |
|---|---|
| `manifest.json` | 插件清单（apiVersion 1，deps: secrets） |
| `index.cjs` | 插件入口：工具注册、搜索请求、IPC、窗口生命周期 |
| `ui.html` | 设置弹窗（Key 的填写 / 清除 / 状态展示） |
