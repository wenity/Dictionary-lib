# 轻量化中英互查工具技术方案

## 1. 目标

基于 PRD，先落地一个轻量、快速呼出的桌面查词工具，满足：

- 全局快捷键唤起
- 窗口打开后自动聚焦输入框
- 中英文互查
- 支持本地大模型与第三方 API Key 两种 AI 来源
- 结果清晰、响应快、便于后续扩展

## 2. 推荐技术栈

### 2.1 总体方案

- 桌面框架：Tauri
- 前端：React + TypeScript
- 后端：Rust
- 状态管理：Zustand
- 构建工具：Vite
- 配置持久化：本地配置文件 + 系统安全存储

当前 demo 已按 **Vite + Tauri** 骨架整理，前端入口由 `src/main.js` 统一加载页面与样式，Rust 入口位于 `src-tauri/src/main.rs`。当前桌面端通过 `invoke("translate_text")` 调用 Rust 侧 AI 命令，再访问 OpenAI 兼容 HTTP 接口；浏览器预览保留离线示例兜底，设置页统一管理服务地址、模型名称与 API Key。模型名称由用户手动填写并读取已保存值，服务地址只需要填写基础地址，运行时会自动补全 `/v1`。

### 2.2 选择理由

- Tauri 体积小、启动快，更符合“轻量化工具”定位
- React + TypeScript 便于快速实现 UI 和状态流转
- Rust 适合封装窗口控制、快捷键、配置读取等系统能力
- 前后端边界清晰，后续接入更多 AI Provider 方便

## 3. 架构设计

### 3.1 分层

1. **UI 层**
   - 输入窗口
   - 输出窗口
   - 设置页（AI 配置）
   - 状态提示区（仅保留必要状态）

2. **应用层**
   - 查询流程编排
   - 输入合法性校验
   - AI Provider 选择
   - 错误处理

3. **平台层**
   - 全局快捷键
   - 窗口显示/置前
   - 自动聚焦
   - 配置读写

4. **AI 适配层**
   - 本地模型适配器
   - 云端 API 适配器
   - 统一请求/响应格式

### 3.2 数据流

用户按快捷键 -> Tauri 打开窗口 -> 前端自动聚焦输入框 -> 用户输入词语 -> 应用层选择 Provider -> 调用 AI -> 解析结果 -> 渲染到输出窗口；AI 配置通过设置页维护。用户不手动选择输出语言，系统根据输入内容自动做中英互翻。

## 4. 项目结构建议

```text
package.json
vite.config.js
index.html
src/
  main.js
src-tauri/
  build.rs
  Cargo.toml
  tauri.conf.json
  src/
    main.rs
```

## 5. 核心模块设计

### 5.1 窗口与快捷键

职责：

- 注册全局快捷键
- 快捷键触发时打开/置前窗口
- 窗口打开后自动聚焦输入框
- 窗口关闭时仅隐藏到后台，不直接退出进程
- 通过全局快捷键保留常驻入口，便于再次唤起

建议：

- 默认固定一个快捷键，先不做复杂配置
- 重复触发时优先调用窗口置前
- 输入框焦点由前端在窗口显示后主动请求

### 5.2 查询流程

建议流程：

1. 用户输入文本
2. 前端先做空值校验
3. 根据输入内容判断中/英文
4. 自动映射目标语言（中文 -> 英文，英文 -> 中文）
5. 选择当前启用的 AI Provider
6. 发起查询
7. 仅展示目标语言翻译，不展示解释或推理过程

建议约束：

- 输出尽量简短
- 单词、短语优先
- 避免长篇生成
- AI 请求只要求纯文本翻译；后端向前端返回类型化的 `{ translation: string }`

### 5.3 AI Provider 抽象

定义统一接口，屏蔽不同来源差异。

```ts
interface AiProvider {
  name: string;
  testConnection(): Promise<void>;
  translate(input: string, sourceLang: "zh" | "en"): Promise<TranslateResult>;
}
```

建议实现两个 Provider：

- `LocalModelProvider`
- `ApiKeyProvider`

当前实现可直接复用同一套 OpenAI 兼容 `chat/completions` 请求，只在 Rust 侧的服务地址和鉴权头上区分本地与云端配置；连通性测试保持请求 `GET /v1/models`，仅检查服务响应，不解析模型列表、不验证模型名称或生成能力。生成能力需通过实际翻译查询验证，浏览器预览不发起真实连通性请求。

前端 `testConnection` 成功时保持 `translationText` 为“连接正常”，设置页辅助文案明确仅测试服务连通性、不验证模型生成能力；浏览器提示“离线预览无法测试真实 AI 服务”。这些是状态文案，不属于 AI 翻译响应。

设置页通过 `modelName` 文本输入框手动填写模型名称；启动时从 localStorage 读取已保存的模型名，输入变更时保存。未保存有效值时沿用默认模型 `qwen2.5:7b-instruct`。不再提供模型列表获取命令、下拉框、刷新按钮或列表状态；启动、打开设置页、切换来源以及修改地址或 API Key 均不会触发模型列表请求。

本地模型模式的 Rust HTTP 客户端使用 `no_proxy()`，避免启动环境的 HTTP/HTTPS 代理将内网请求转发至不可达的网关；第三方 API 模式保持 reqwest 默认代理策略。连接测试成功仅代表服务接口可达，模型名称须填写服务端实际存在且支持文本生成的模型。

### 5.4 稳定数据结构规范

为避免“词条命中但翻译方向错误”这类问题，离线演示、测试和后续真实词库数据统一遵守以下约定；此词条结构不是 AI 响应契约：

1. **输入语言先判定，再找词条**
   - 先用 `languageDetect` 判断输入是 `zh` 还是 `en`
   - 查询时只匹配同语言来源的词条

2. **词条结构显式声明方向**
   - 每条词条必须包含：
     - `sourceLang`
     - `aliases`
     - `translation`
     - `explanationZh`
   - `translation` 永远表示“输出目标语言”的结果
   - `explanationZh` 永远使用中文，仅保留为词条数据，不展示、不纳入 AI 响应

3. **词条不复用双向字段**
   - 不再使用 `zh/en` 两层嵌套对象来推断方向
   - 不再依赖“猜测哪个字段是目标语言”

4. **别名只做匹配，不决定输出**
   - `aliases` 只用于命中查询
   - 命中后输出仍然以 `sourceLang -> translation` 为准

5. **示例数据和真实词库数据遵循同一 schema**
   - demo、测试、后续真实词库都必须使用同一套结构

推荐类型：

```ts
type Language = "zh" | "en";

type DictionaryEntry = {
  sourceLang: Language;
  aliases: string[];
  translation: string;
  explanationZh: string;
};
```

推荐查找流程：

```ts
const sourceLang = detectLanguage(input);
const entry = demoEntries.find((item) =>
  item.sourceLang === sourceLang &&
  item.aliases.includes(normalize(input)),
);
```

### 5.5 配置管理

配置建议分两类：

1. **普通配置**
   - 当前 Provider 类型
   - 模型名称
   - 本地服务地址
   - 其他非敏感参数

2. **敏感配置**
   - API Key

保存策略：

- 普通配置：本地配置文件
- 敏感配置：系统安全存储

### 5.6 结果展示

结果区建议支持以下状态：

- 空状态
- 加载中
- 成功
- 失败

结果内容建议包含：

- 主翻译
- 移除简短说明 UI；词条的 `explanationZh` 不渲染
- 不展示模型推理内容，连通性测试仅展示必要状态
- 不展示当前来源、耗时、调试状态等非必要信息

## 6. AI 接口建议

### 6.1 统一请求格式

建议将所有 Provider 适配为类似 OpenAI 风格的结构，便于后续扩展。

### 6.2 Prompt 建议

使用简短提示词，仅请求目标语言的纯文本翻译，例如：

`Translate to {targetLanguage}. Return only the translation, no explanation or JSON.`

目标语言由输入语言决定（中文 -> 英文，英文 -> 中文），待译文本作为输入传递，不要求结构化模型输出。不得向界面返回推理内容。

当前请求保留原有协议和 160 token 上限，没有已生效的关闭 thinking 参数。2026-10-09 对用户授权服务的 `qwen3-vl:8b` 实测：`chat_template_kwargs.enable_thinking=false` / `think=false` 以及 `reasoning_effort=none` 未阻止思考输出，因此不将这些未验证选项加入生产请求。本次不扩大协议适配范围；该模型的关闭思考与成功翻译仍待服务端配置或后续兼容处理。

### 6.3 响应规范

后端命令向前端返回类型化结构，仅包含：

```ts
type TranslateResult = {
  translation: string;
};
```

模型输出与后端响应结构分开：模型正常返回目标语言纯文本，后端校验非空后包装为 `TranslateResult`。兼容旧版合法 JSON 时，只接受非空字符串 `translation`，提取该字段并忽略解释等其他字段。

畸形、截断的 JSON 类输出（包括 JSON 代码围栏）必须明确失败；合法 JSON 缺少有效 `translation` 也必须失败。禁止将这些输出回退成原始文本翻译，禁止把解释或推理内容混入翻译。

`finish_reason=length` 即使带有看似合法的内容也判为截断错误；不读取独立 `reasoning` 字段或思考类型的内容块，带 `<think>` 标签的译文也拒绝。Rust 测试覆盖纯文本（含多行）、旧版 JSON、畸形/截断 JSON、空字段、思考内容以及本地 HTTP 请求链路。

2026-10-09 使用 Rust 实际命令直连授权服务，连接测试通过；`qwen3-vl:8b` 对“桌面工具”和“hello”均因思考耗尽 160 token 而无译文，应用返回“AI 返回内容被截断，请调整模型配置后重试。”，未把推理当翻译。此回归验证的是安全失败，不代表该模型成功翻译。

## 7. 错误处理

需要明确覆盖：

- 输入为空
- 未配置 Provider
- 本地模型连接失败
- API Key 无效
- 请求超时
- AI 返回空翻译、无有效 `translation` 的旧版 JSON、畸形或截断 JSON 类输出
- 模型返回解释或推理内容而非有效翻译

建议每类错误都映射成可读文案，避免直接暴露底层异常。

## 8. 关键实现点

### 8.1 自动聚焦

窗口显示完成后，前端主动触发输入框 `focus()`，必要时结合 Tauri 的窗口事件保证稳定性。

### 8.2 置前逻辑

如果窗口已打开：

- 直接激活窗口
- 显示到前台
- 聚焦输入框

### 8.3 防抖与重复查询

- 输入触发查询时建议做防抖
- 回车查询优先保证稳定性
- 新请求发起前可取消前一个未完成请求

## 9. MVP 实施顺序

### Phase 1：基础壳

- Tauri 项目初始化
- React 页面框架
- 窗口唤起与聚焦

### Phase 2：查询能力

- 输入框
- Provider 抽象
- 接通本地模型或云端 API
- 结果展示

### Phase 3：配置能力

- 设置页
- Provider 切换
- 安全存储 API Key
- 测试连通性

### Phase 4：体验优化

- 错误提示优化
- 加载态优化
- 输入体验优化
- 查询结果结构优化

## 10. 风险与应对

- **本地模型兼容性不一**：先支持 OpenAI 风格接口或常见 HTTP 兼容协议
- **窗口聚焦不稳定**：前后端都保留聚焦逻辑，双重保障
- **AI 返回不稳定**：模型只请求纯文本翻译，后端统一返回 `{ translation: string }`；旧版 JSON 严格提取翻译，异常 JSON 类输出明确失败，不做原文兜底
- **API Key 安全性**：必须使用系统安全存储，不直接明文写入普通配置

## 11. 后续可扩展点

- 快捷键自定义
- 历史记录
- 收藏
- 发音
- 例句
- 划词翻译
- 剪贴板监听

## 12. 结论

如果目标是快速交付一个轻量、稳定、可扩展的桌面查词工具，建议采用：

**Tauri + React + TypeScript + Rust**

这套方案在性能、体积、扩展性之间比较均衡，适合作为 MVP 的长期基础。

## 13. 项目实现进度表

项目进度表已拆分到独立文件：`PROJECT_PROGRESS.md`。
