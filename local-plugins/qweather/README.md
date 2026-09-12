# 和风天气（qweather）

让 Cyrene 查询详细天气的运行时插件，基于和风天气 API。
工具实现移植自 Castorice-Agent 的 `qweather_weather` 内置工具。

## 功能

- 注册 Agent 工具 `qweather_weather`，Cyrene 在用户问天气相关问题时自动调用：
  - **实时天气**：温度、体感、湿度、风力、降水、气压、能见度 + 空气质量（AQI/PM2.5/PM10）
  - **未来三天预报**：每日白天/夜间天气、最高最低温、风力、降水
  - **空气质量**：AQI、等级、首要污染物
  - **生活指数**：穿衣、紫外线、运动等 6 项
- 支持城市与区县级定位（多级查询消歧，如「湖北省 武汉市 武昌区」）
- API Key 与专属 Host 存系统级安全存储（`secrets`），不进对话与日志

## 安装

1. ZIP 导入：聊天窗口 → 插件 → 添加 → 选 `qweather-0.1.0.zip`；
   或把 `qweather` 文件夹复制到 `%APPDATA%\live2d-cyrene\plugins\`
2. 插件面板点「启用」
3. 点「打开」填配置：
   - **专属 API Host**：和风控制台 console.qweather.com → 设置，形如 `https://abc123.def.qweatherapi.com`
     （公共地址 devapi.qweather.com 已停用，必须用专属 Host）
   - **API Key**：同在控制台创建

## 验证

对 Cyrene 说「武汉今天天气怎么样」「查一下未来三天杭州的天气」，确认她调用「天气查询」工具。

## 文件

| 文件 | 说明 |
|---|---|
| `manifest.json` | 插件清单（apiVersion 1，deps: secrets） |
| `index.cjs` | 工具注册、和风 API 客户端、城市定位、渲染 |
| `ui.html` | 设置弹窗（Host + Key 配置） |
