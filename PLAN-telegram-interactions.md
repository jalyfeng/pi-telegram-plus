# Plan: Telegram 远程交互不破坏 TUI（以 `/goals` 确认为例）

## 0. 设计原则（最高约束）

**Telegram 远程操作不得破坏本地 TUI 的体验。** 任何方案都必须同时满足：

1. **交互模态框（confirm/select/input/custom）**：谁触发的 turn 就给谁。
   - Telegram 触发的 turn → 模态框走 Telegram（按钮/文本），**不抢 TUI 键盘焦点、不在 TUI 里弹框**。
   - TUI 触发的 turn（本地用户在终端敲 `/goals`）→ 一切走 TUI，**与 Telegram 无关，行为完全不变**。
2. **持久/状态类 UI（goal widget、status line、working indicator、footer/header 等）**：始终回写 TUI，保证本地用户看到的 TUI 状态是准确的，**即使触发来自 Telegram**。
3. **编辑器操作（pasteToEditor/setEditorText/getEditorText/setEditorComponent/onTerminalInput 等）**：Telegram turn 期间 no-op —— 远程不得往本地用户正在编辑的输入框里塞东西、也不得读走本地用户的草稿。
4. **不挂死**：任何检测失败必须降级为 `undefined`（RPC 模式 `custom` 契约），绝不让工具 promise 永久 pending。

> 上一版方案 Layer A 把 `setWidget/setStatus/...` 全部 no-op，违反了原则 2：Telegram
> 触发的 goal 创建/更新不会回写 TUI，本地 goal 状态条/widget 就坏了——这本身就是
> "Telegram 影响了 TUI"。本版用**选择性转发**修正。

## 1. 问题现象

- `/goals` / `/sisyphus` 流程中 agent 调 `propose_goal_draft` → pi 的 TUI 弹出
  "Confirm Goal Draft / Continue Chatting" 确认框，Telegram 端看不到、无法操作。
- agent 调 `goal_question` / `goal_questionnaire` → TUI 弹问答组件。
- goal 运行时 TUI 顶部出现 `GoalWidget` 状态条（纯展示）。

## 2. 根因分析

### 2.1 Telegram UI 上下文怎么搭起来

`lib/telegram-ui.ts` 的 `create(chatId)`：

```ts
const base = deps.getSession()?.extensionRunner.getUIContext?.();  // ← 此时是 TUI UI
return {
  ...(base as ExtensionUIContext),   // ← 整体展开 TUI UIContext
  chatId,
  notify: ..., confirm: ..., input: ..., inputSecret: ..., editor: ..., select: ...,
};
```

关键事实：`create()` 在 `runWithTelegramUi` swap **之前**调用（见 `controller.ts`：
`const telegramUi = deps.ui.create(chatId);` 在 `runWithTelegramUi({...})` 之前），
所以 `base` 拿到的是**真实的 TUI UI 上下文**。这让我们可以转发有状态方法给 `base`。

它只覆盖了 `notify/confirm/input/editor/select/inputSecret`，其余方法（`custom` /
`setWidget` / `setStatus` / `setFooter` / `setHeader` / `setWorkingMessage` / ...）
**全部继承自 TUI base**。

### 2.2 pi-goal 怎么发起确认

`@capyup/pi-goal` 的 `propose_goal_draft`：

```ts
const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: PI_GOAL_AUTO_CONFIRM });
// = !hasUI || env==="1"
if (headless) decision = "confirm";
else decision = await showProposalDialog(ctx, draftSummary, focus);
```

`showProposalDialog` → `runGoalQuestionnaire` → **`ctx.ui.custom<GoalQuestionnaireResult>(factory)`**。

`runner.hasUI()` = `uiContext !== noOpUIContext`（`dist/core/extensions/runner.js:245`）。
Telegram turn 期间 `uiContext` 是我们的 Telegram UI（非 noOp），所以 `hasUI===true`，
pi-goal 走 TUI 弹框分支。但 `ctx.ui.custom` 继承自 TUI → **确认框渲染进终端**，且会**抢占
TUI 键盘焦点**——这正是"Telegram 影响 TUI"的最坏情况：远程用户触发的操作把本地用户的
终端抢走了。同理 `setWidget` 直接画进 TUI（这个本身不算坏，但见 2.3）。

### 2.3 为什么不能 `hasUI=false`

那样 `shouldAutoConfirmProposal` 返回 true → 自动确认、跳过用户确认，违背
`propose_goal_draft` 的本意。方向必须是"让确认框在 Telegram 里能用"，不是"关掉它"。

### 2.4 为什么不能把状态类方法 no-op（上一版的错）

pi-goal 的 `updateUI(ctx)` 在 goal 创建/更新/事件时调用 `ctx.ui.setWidget(GOAL_WIDGET_KEY,
factory, {placement:"aboveEditor"})` 和 `ctx.ui.setStatus("goal", ...)`。`widgetRegistered`
是 pi-goal 模块级 flag。若 Telegram turn 期间 `setWidget` no-op：
- `widgetRegistered` 被置 true，但 TUI 的 widget 从未注册 → 本地 TUI 看不到 goal 状态条。
- goal 创建发生在 Telegram turn 里时，TUI 的 widget 永远不会出现。

→ 违反原则 2。**状态类方法必须转发给 TUI base。**

### 2.5 `custom` 的本质约束

`ExtensionUIContext.custom<T>(factory)` 的 factory 是
`(tui, theme, kb, done) => Component & { render(width); handleInput(key); invalidate() }`，
不透明、无结构化协议。pi-core 自己的 RPC 模式对 `custom` 也只实现 `async custom(){ return undefined }`。
pi-goal 是第三方包不能改源码。结论：**`custom` 没有通用桥接**，只能"已知形态桥接 + 未知安全降级"。

## 3. 解决策略（分层）

### Layer A — 选择性转发（修正版核心）

`telegram-ui.ts` 的 `create()` 不再 `...(base)` 整体展开，改为**按方法分类显式实现**：

| 方法类别 | 方法 | 实现 |
|---|---|---|
| **交互模态框** | `confirm` `select` `input` `editor` `inputSecret` | 已有 Telegram 实现，**保持**。不转发 base（避免 TUI 弹框抢焦点）。 |
| **交互模态框** | `custom` | 新增 Telegram 桥接（Layer B），**不转发 base**。 |
| **持久/状态类 UI** | `setWidget` `setStatus` `setWorkingMessage` `setWorkingVisible` `setWorkingIndicator` `setHiddenThinkingLabel` `setFooter` `setHeader` `setTitle` `setToolsExpanded` `getToolsExpanded` | **转发给 `base`**（TUI 保持准确）。不镜像到 Telegram（Telegram 有自己的 status line 机制；goal 运行通知已由 pi-goal 通过 `ctx.ui.notify` 发到 Telegram）。 |
| **编辑器/终端输入** | `onTerminalInput` `pasteToEditor` `setEditorText` `getEditorText` `setEditorComponent` `getEditorComponent` `addAutocompleteProvider` | **no-op**（远程不得碰本地编辑器；`getEditorText` 返回 `""`，`getEditorComponent` 返回 `undefined`）。 |
| **主题** | `setTheme` `getTheme` `getAllThemes` | `getTheme`/`getAllThemes` 转发 base（只读，给 factory 渲染用）；`setTheme` 转发 base（设置类操作应真正生效）。 |
| **`theme` getter** | — | 指向 base theme（只读，factory 里 `theme.fg(...)` 要能用）。 |
| **`notify`** | — | 保持 Telegram 实现（已是 Telegram，不转发 base——本地 TUI 的 notify 由 TUI 自己的 ctx.ui 负责，不归 Telegram turn）。 |

> 关键不变量：`runWithTelegramUi` 只在 **Telegram 触发**的 turn/命令里 swap UI；
> 本地 TUI 用户敲 `/goals` 走 TUI 自己的命令分发，`ctx.ui` 就是 TUI UI，**完全不走本方案**，
> 行为零变化。这从架构上保证了"Telegram 不影响 TUI"。

### Layer B — 桥接 pi-goal 的 `custom`

在 `lib/custom-dialogs.ts` 实现 `custom<T>(factory): Promise<T | undefined>`：

1. 构造最小 `tui` shim（只需满足 pi-goal factory 里 `new Editor(tui, editorTheme)` /
   `tui.requestRender()`）。不需要真终端，只要 factory 能跑、能 `render(width)` 取文本。
   - 若 `Editor` 依赖面太大导致 shim 不可行 → 回退到 **factory 源码特征匹配**
     （`factory.toString()` 含 `GoalQuestionnaireResult` / `confirmationText`），仅用于
     确认框 + 单问场景。
2. `const component = factory(tuiShim, theme, kbShim, done)`，try/catch。
3. `const text = stripAnsi(component.render(80).join("\n"))`。
4. **按渲染文本识别形态**：
   - **goal 确认框**：首行匹配 `^Confirm (Sisyphus )?Goal Draft` 且末尾两选项含
     `Confirm — create this goal now` 与 `Continue chatting`。
     → 复用现成 flow 机制 `sendOrReplaceButtons` 发 `✅ Confirm` / `💬 Continue chatting`；
     `/stop`/超时视为取消。
     → Confirm：`done({ questions:[], answers:[{ id:"confirm", question:<header>, answer:"Confirm — create this goal now", wasCustom:false }], cancelled:false })`
     → Continue：`answer` 换成 `"Continue chatting — keep refining"`。
     → 取消：`done({ questions:[], answers:[], cancelled:true })`。
     （`showProposalDialog` 只看 `result.answers[0]?.answer.startsWith("Confirm")` 与
     `cancelled`，组件被旁路，只依赖这两个字段。）
   - **`goal_question` 单问**：渲染文本里有当前问题 + `displayOptions()` 标签。
     → 发问题文本 + 选项按钮（分页）+ `✏️ Type answer`（切自由文本，收下一条 Telegram
     文本）+ `Cancel`。
     → `done({ questions:[{...}], answers:[{ id, question, answer, wasCustom }], cancelled:false })`。
   - **`goal_questionnaire` 多问**：v1 降级——
     `done({ questions:[], answers:[], cancelled:true })` +
     `notify("多问题问卷暂不支持 Telegram，请在对话里逐条提问。")`。
     agent 收到 cancelled 后会在 Telegram 聊天里继续追问，体验可接受。
   - **未知组件**：`notify("⚠️ 终端专用对话框已自动取消，agent 将继续。")` 后**不调 `done`**，
     `return undefined`（与 RPC 模式 `custom` 一致）。pi-goal 对 `custom` 返回 undefined
     走 cancelled 路径，安全。
5. 全程复用 `telegram-ui.ts` 现成 flow（`beginFlow / waitInput / sendOrReplaceButtons /
   resolveInput`），与 `confirm/select` 一致，不重复造轮子。`done` 只调一次。

**安全不变量**：检测失败一律落"未知组件 → `undefined`/cancelled"，**绝不挂死**。检测所依赖
的字符串（header、两个选项）在 pi-goal 里是字面量，版本间较稳；即便将来变了也安全降级。

### Layer C — 一致性与生命周期

- **swap 生命周期**：`runWithTelegramUi` 在 `finally` 里 `setUIContext(previousUi)` 恢复 TUI UI。
  我们的 Telegram UI 转发 `setWidget` 给 base（TUI UI），所以 widget 注册在 TUI 上，turn 结束
  后 TUI widget 仍然正确显示。**不会出现"turn 结束后 TUI widget 丢失/残留模态框"**。
- **`custom` 不调 TUI 的 custom**：TUI 不会被装上模态框，turn 结束无残留焦点抢占。
- **`hasUI` 仍为 true**：pi-goal 走弹框分支（被我们桥接到 Telegram），不会误走自动确认。

### Layer D — 文档

`README.md` 增加"第三方对话框支持"小节：支持的 pi-goal 场景、`goal_questionnaire` 多问降级、
受测 pi-goal 版本范围、以及"Telegram turn 不影响本地 TUI"的保证。

## 4. 具体改动清单

### `lib/telegram-ui.ts`（主改动）
- 重写 `create(chatId)`：不再 `...(base)`，按 Layer A 表逐方法显式实现。
- 保留 `base` 引用（已在 `create` 里取得），用于转发状态类方法。
- 新增 `custom<T>(factory)`：委托 `lib/custom-dialogs.ts`，传入 `base.theme`、flow 工具。
- 状态类方法转发：`setWidget: (k,c,o)=>base.setWidget(k,c,o)`、`setStatus`、
  `setWorkingMessage`、`setWorkingVisible`、`setWorkingIndicator`、`setHiddenThinkingLabel`、
  `setFooter`、`setHeader`、`setTitle`、`setToolsExpanded`、`getToolsExpanded`、`setTheme`、
  `getTheme`、`getAllThemes` 全部 `=> base.xxx(...)`。
- 编辑器类 no-op：`onTerminalInput: ()=>()=>{}`、`pasteToEditor: ()=>{}`、
  `setEditorText: ()=>{}`、`getEditorText: ()=>""`、`setEditorComponent: ()=>{}`、
  `getEditorComponent: ()=>undefined`、`addAutocompleteProvider: ()=>{}`。
- `theme` getter：`get theme() { return base.theme; }`。
- `notify/confirm/input/editor/select/inputSecret`：保持现有 Telegram 实现。
- 把按钮 flow 抽成共享工具，供 `custom` 桥接器复用。

### `lib/custom-dialogs.ts`（新增）
- 导出 `bridgeCustomDialog<T>(deps: { factory, theme, width, sendButtons, waitInput, cancel, notify }) => Promise<T | undefined>`。
- 内部：tui shim → 实例化 → render → stripAnsi → 形态识别 → Telegram 按钮流 → 调 `done`。
- 内联 `stripAnsi`（一行正则，不依赖 pi-core 深路径 `dist/utils/ansi.js`）。

### `lib/html.ts` 或新 `lib/ansi.ts`
- 加 `stripAnsi(s)` 工具（若已存在则复用）。

### `lib/__tests__/telegram-ui-custom.test.ts`（新增）
- 桩 factory（`render(width)` 返回固定文本行）模拟 goal 确认框：
  - 点 `✅ Confirm` → `done` 收到 `answers[0].answer === "Confirm — create this goal now"`、`cancelled:false`。
  - 点 `💬 Continue chatting` → `answer === "Continue chatting — keep refining"`。
  - `/stop`/超时 → `cancelled:true`。
- 未知组件 factory（render 返回随机文本）→ `bridgeCustomDialog` resolve `undefined`，且 `notify` 被调一次。
- 新增一条：状态类方法转发测试——给 Telegram UI 调 `setWidget("goal", factory, opts)`，
  断言 `base.setWidget` 被以相同参数调用（确保 TUI widget 回写）。

### `README.md`
- 新增"第三方对话框支持 / Telegram 不影响 TUI"小节。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| pi-goal 版本升级后 header/选项字符串变化 | 检测失败安全降级 `undefined`（cancelled），绝不挂死；文档写明受测版本。 |
| tui shim 无法满足 `Editor` 依赖 | 回退 factory 源码特征匹配（仅确认/单问）。 |
| 状态类转发到 base 时 base 已失效（session rebind 后 `runner.uiContext` 重置） | `create()` 每次取最新 base；rebind 后 Telegram turn 重新 `create()`，base 重新取，不持旧引用跨 turn。 |
| 多问 `goal_questionnaire` 降级为 cancelled 影响体验 | agent 会在 Telegram 聊天里继续追问，可接受；后续再迭代驱动式桥接。 |
| `setWidget` 转发到 TUI，本地 TUI 用户突然看到 goal widget 出现 | 这是**正确行为**（goal 确实激活了），不是破坏；与本地用户自己敲 `/goals-set` 的结果一致。 |
| Telegram turn 期间本地 TUI 用户也在操作 | 交互模态框只走 Telegram，不抢 TUI 焦点；状态类回写 TUI 让本地用户看到真实状态；编辑器 no-op 防止远程篡改本地草稿。三者共同保证 TUI 体验不被打断。 |
| 未知扩展依赖 `custom` 返回真实结构 | 与 RPC 模式行为一致（`undefined`）；扩展本应处理 `custom` 不支持的情况。 |

## 6. 验收标准

1. **TUI 不被打断**：Telegram 发 `/goals <topic>`，agent 走完讨论并调 `propose_goal_draft`
   时——TUI 里**不出现**任何确认弹框/键盘焦点抢占；Telegram 收到 `✅ Confirm` / `💬 Continue chatting` 按钮。
2. **Telegram 可交互**：点 Confirm → goal 创建、agent 终止本轮并报告；点 Continue → agent
   在 Telegram 聊天里继续追问；`/stop`/超时 → 取消。
3. **TUI 状态准确（关键新增）**：Telegram 触发创建的 goal，其 `GoalWidget` 和 status line
   在本地 TUI 里**正确显示**（因为 `setWidget/setStatus` 转发到了 base）。turn 结束后 TUI 无残留模态框。
4. **本地 TUI `/goals` 完全不变**：本地终端敲 `/goals` 走 TUI 自己的 UI，确认框在 TUI 里正常弹出，
   行为与本扩展安装前一致。
5. **goal_question 单问**：Telegram 出现问题 + 选项按钮 + 自由文本入口；回答后 agent 收到答案。
6. **goal_questionnaire 多问**：Telegram 收到降级提示，agent 改在聊天里逐条提问。
7. **未知 custom**：Telegram 收到"已自动取消"提示，agent 不卡死。
8. **编辑器隔离**：Telegram turn 期间任何 `setEditorText/pasteToEditor` 不影响本地 TUI 输入框。
9. `npm run typecheck` 通过；`npm test` 全绿（含新增测试）；`TelegramUiRuntime` 类型签名不破坏
   `controller.ts/index.ts` 现有调用。