# 高德周边探索（amap-explorer）

让 Cyrene 搜索地点与周边的运行时插件，基于高德地图 Web 服务 API。
工具实现移植自 Castorice-Agent 的 `amap_poi` 内置工具。

## 功能

- 注册 Agent 工具 `amap-explorer_search`，Cyrene 在用户找地方时自动调用：
  - **关键词搜索**：如「杭州有什么好吃的咖啡店」「找家川菜馆」
  - **周边搜索**：如「杭州东站附近 1 公里内的餐厅」——中心地名自动解析坐标，结果带距离
- 结果含店名、距离（周边搜索）、类型、地址，最多 8 条
- 内置免费版 QPS 保护：全局串行 + 请求间隔节流 + 瞬时错误自动重试（LLM 并行调用也安全）
- API Key 存系统级安全存储（`secrets`），不进对话与日志

## 安装

1. ZIP 导入：聊天窗口 → 插件 → 添加 → 选 `amap-explorer-0.1.0.zip`；
   或把 `amap-explorer` 文件夹复制到 `%APPDATA%\live2d-cyrene\plugins\`
2. 插件面板点「启用」
3. 点「打开」粘贴高德 API Key（console.amap.com → 创建 Key → 类型选「Web 服务」）

## 验证

对 Cyrene 说「帮我找找附近好吃的日料」「西湖旁边有什么好玩的」，确认她调用「地点搜索」工具。

## 文件

| 文件 | 说明 |
|---|---|
| `manifest.json` | 插件清单（apiVersion 1，deps: secrets） |
| `index.cjs` | 工具注册、高德 API 客户端（节流/重试）、地理编码、渲染 |
| `ui.html` | 设置弹窗（Key 配置） |
