# 重构技术方案：Telegram 等价使用 TUI 全部命令

> 状态：设计稿 v4，待实现
> 适用宿主：pi（`@earendil-works/pi-coding-agent`，核对版本 0.81.1）、OMP（`omp/18.12.5`，安装在 `~/.local/bin/omp`，编译后的单文件）
> 取代：`docs/telegram-interactions-plan.md` 的**原则 1**（"Telegram 发起的对话框只走 Telegram，不在 TUI 弹框"）。该文档的原则 2（状态类 UI 回写 TUI）、原则 3（Telegram turn 期间不碰本地编辑器）、原则 4（不挂死）继续有效。
> 读者：负责实现的工程师或模型。本文自包含，不依赖之前的对话。
> 引用约定：插件代码一律用**函数名或常量名**定位（行号会漂移）；pi 宿主代码用"文件 + 函数名 + 0.81.1 行号"，因为发布包内容是固定的。
> 修订说明见 §11。

---

## 0. 一句话

**除插件独有的命令（`pluginOnly`，§4.2.1）外，所有命令都交给宿主自己执行；插件在宿主的"输出入口"和"焦点变化"处截获结构化数据，用 Telegram 原生消息和按钮呈现；用户在 Telegram 上的操作通过宿主组件自己的输入处理回传。谁发起，谁显示：Telegram 发起的对话框两边都能看到（宿主一定会画在终端上），谁先操作谁生效；本地发起的不推送到 Telegram。**

不再在 Telegram 里重写命令逻辑，不再解析终端画面文本来生成可操作按钮。

### 0.1 v6 生效规则（2026-10-24，优先于本文其他位置的冲突内容）

1. **只支持一个宿主版本**：pi `1.4.0`、OMP `18.12.x`。版本不符或读不到版本时，插件启动直接报错（状态栏 + Telegram 提示），不做任何降级或兼容。`peerDependencies` 固定为 pi `1.4.0`；不再维护多版本测试矩阵。
2. **以宿主源码为准**：本地只读副本 pi `/Users/jaly/Documents/project/research/pi-1.4.0`（tag `v1.4.0`）、OMP `/Users/jaly/Documents/project/research/oh-my-pi-18.12.5`（tag `v18.12.5`）。文中所有"pi 0.81.1、第 N 行"的字段和行号引用作废，以 1.4.0 源码为准，任务 A1 核对后逐处更新；`docs/host-probe/pi-0.81.1.json` 及基于它的结论作废。
3. **不做降级，只有一套做法**：识别不了的对话框不给截图加方向键，也不交回屏幕镜像，而是在 Telegram 明确告知"终端上有一个 Telegram 无法处理的对话框（<类型>），请在终端处理"，只提供"取消"按钮（发 Esc）。桥接不可用（宿主以 RPC/print 模式运行、hook 失败）时插件启动直接报错，不退回插件原生实现。
4. **立即删除旧路径**（任务 D1–D4，先于后续迁移）：`off` 模式与 `tuiBridge` 配置项、旧屏幕镜像（`runTuiCommand`、`tui-selector.ts`、`tgplus:tui:` 回调）、插件重做宿主功能的原生实现（`lib/commands/` 中 model/session/settings/auth 等对应部分、`telegram-ui.ts` 中对应的原生对话框流程、`custom-dialogs.ts`）、快照方向键。插件自己的管理功能（`/tg` 菜单、`/stop`、`/pair` 等 `pluginOnly` 命令）保留。
5. **E2E"待迁移"清单**：删除旧路径后，尚未迁移到新架构的命令在 Telegram 上暂时没有输出或交互。E2E 套件维护一份"待迁移"清单：清单内步骤失败算预期结果，单独列出；清单外步骤失败才算回归。每完成一项迁移，从清单中移除对应步骤。
6. 本节与 §4.11（OMP 结构化通道）、§9 决定 41–50 共同构成 v6 的约束。

### 0.2 v8 生效规则（2026-10-28，优先于本文其他位置及 §0.1 的冲突内容）

背景：#19（长会话后 `/tg`、`ask` 栈溢出，#16 复发）和 #20（命令回复混入 agent 工具框）都出在"观察终端渲染、反推归属"的镜像层。W-1 实测：OMP 上 UI 上下文的 13 个对话框方法约每秒被重装一次（94 秒 95 次）；pi 上每次 `/new`、`/reload` 在自己上一层包装外再套一层（`ptp:showExtensionSelector > ptp:…`）。

**交互规则（用户确认）**

1. **对话区不归插件截取。** agent 消息、用户消息、工具调用由 `lib/renderer.ts` 经 session 事件发送，这部分保持不变。Telegram 上的命令/工具交互只对应 TUI **输入框区域**的内容（宿主在那里临时替换编辑器画出的选择器、输入框、登录提示、进度）。
2. **TUI 上能选择 → Telegram 内联按钮（可翻页）；TUI 上是文本展示 → Telegram 文本。** 文本只取宿主给的结构化数据：对话框入口参数、组件的 `text`/`markdown` 等字段、`showStatus`/`showError`/`showWarning` 的字符串、扩展 `notify`、`showCommandReport` 的 `title`。
3. **不做终端镜像：不调用 `render()` 读画面。** 拿不到结构化数据的界面，一律提示"Telegram 不支持，请在终端操作"，只给"取消"。
4. **一条命令一条消息，原地编辑。** 按钮、进度、结果都在同一条 Telegram 消息上 `editMessageText` 替换，完成后移除按钮。
5. 本地发起的对话框只在终端（原则 3 不变）。

**由此删除**

- `OutputCapture` 对 `chatContainer.addChild` 的截取：`AGENT_CTORS`、`AGENT_FIELDS`、方法形状排除（2f936f5）、`clear` 重建窗口、`REBUILD_OUTPUT_LABELS`、`renderComponent` 的 `render()` 分支、`showCommandReport` 的 body 渲染。保留：`showStatus/showError/showWarning`、`/export` 发文件、`!` 命令的 bash 结果（宿主 bash 组件的 `getOutput()`，见下）。
- 用渲染文本工作的适配器：`customGoalAdapter`（pi-goal，§4.6.6 例外一作废）、`infoPanelAdapter` 的 `renderText`（改为只读结构化字段，读不到则按 unsupported）、`adapters/utils.ts` 的 `renderText`。
- `!` 命令结果改为读宿主 bash 组件的 `getOutput()`，不再 `render()`；认领方式（"!" scope 内的 bash 执行组件，含 pending 区）不变。

**#19：宿主方法包装改为"每个对象每个方法只有一个包装"**

- 新模块 `lib/tui/hooks.ts` 取代 `install-marks.ts` 的启发式（对象标记、两次读取比较、函数身份、按 tracker 分作用域）以及 `hookMethod`/`installRace`/`hookEntryMethods`/`watchEditor` 各自的包装代码。
- 注册表放在 `globalThis`（`Symbol.for` 键），跨模块实例（OMP `?mtime=` 导入、`/reload`）共享：`WeakMap<object, Map<method, Slot>>`。`Slot = { wrapper, base, handlers: Map<kind, Handler> }`。
- 每个 (对象, 方法) 只有一个 `wrapper`；各功能（race、entry、focus、status、bash…）作为 `kind` 处理器挂在 slot 上，按固定优先级组成调用管道。**再次安装同一 kind 只替换处理器，不新增包装**。runtime 重建（`/new`、`/reload`）时，新 tracker 用同一 kind 覆盖旧处理器，旧 runtime dispose 时移除自己的处理器。
- **身份判断读自有属性描述符，不读 `object[method]`。** 已核实的失效机制（OMP 18.12.5 `extensibility/extensions/user-wait.ts` `trackUserWaits`）：工具 UI 上下文是一个 Proxy，`get` 对底层每个函数值缓存一个匿名转发函数。我们写入的包装落在底层对象上，再读回来得到的是"转发到我们包装的匿名函数"，读取稳定但不是我们的包装 → 旧逻辑每秒在它外面再包一层。`Object.getOwnPropertyDescriptor(proxy, method)` 在没有对应 trap 时转发到底层，拿到的正是我们写入的值。
- 安装规则：
  - 首次：`base` = `object[method]` 读到的值（可能来自原型）；写入 `wrapper`；
  - 之后：自有描述符的 `value === slot.wrapper` → 不动；
  - 自有描述符存在、是函数且不是我们的包装（宿主真的换了方法）→ `slot.base = 描述符的值`（原始函数，不是 Proxy 的转发函数），重新写回同一个 `wrapper`，记 debug 日志；
  - 写入失败（冻结对象）→ 放弃，记 debug 日志。
- 我们的包装统一登记在一个 `WeakSet` 里；`base` 永远不能是登记过的包装（防止自引用）。
- tick 只比较宿主对象身份是否变化；对象没变就不进入安装逻辑。
- 回归测试：上千次 attach tick、tracker 重建、宿主每次读返回新函数、宿主替换方法后换回，调用链深度恒定（每个对象方法至多一层插件包装）。


---

## 1. 背景与现状诊断

### 1.1 目标

- Telegram 上可以使用 TUI 的**全部**斜杠命令（内置命令、扩展命令、提示词模板、技能），以及 Telegram 发起的 agent turn 中弹出的全部对话框（`ask` 工具、扩展的 `select/confirm/input/editor/custom`、OMP 的 `approve`）。
- "等价"的定义是**语义等价**：同样的选项、同样的当前值、同样的可执行操作、执行后宿主状态完全一样。不追求画面一致。
- 对终端专属的命令（剪贴板、外部编辑器、退出等），提供明确的 Telegram 等价替代（§4.8）。

### 1.2 非目标

- 不做像素级终端镜像，也不做网页终端（Telegram Mini App + xterm.js）。
- 不改宿主源码。
- 不改变本地 TUI 用户自己发起的操作的行为。
- 不支持宿主的非捕获浮层（`showOverlay(c, { nonCapturing: true })`）：它们不获得焦点、不接收输入，只是装饰。
- 不保留 `off` 模式与插件原生实现（§0.1 第 4 条，v6）。

### 1.3 现状（为什么要重构）

现在有三条并行的交互通道，具体走哪条取决于配置和写死的命令集合：

| 通道 | 位置 | 做法 | 问题 |
|---|---|---|---|
| Telegram 原生重写 | `lib/commands/*.ts`、`lib/telegram-ui.ts` | 用会话接口重新实现 `/model`、`/session` 等 | 追不上宿主；会漏掉 TUI 回调里的副作用 |
| custom 对话框桥 | `lib/custom-dialogs.ts` | 按 pi-goal 的固定文案匹配 | 只认识 pi-goal |
| 屏幕镜像 | `lib/tui-bridge.ts`、`lib/tui-selector.ts`、`lib/controller.ts` 中的 `refreshTuiMirror`/`startPromptMirror`/`runTuiCommand` | `ui.render(100)` → 去掉颜色码 → 正则识别选项 → 模拟方向键 | 信息丢失、只能靠猜；两天改了 14 次 |

路由分支见 `controller.ts` 中的常量 `TUI_NATIVE_SELECTOR_COMMANDS`、`MIRROR_FIRST_COMMANDS`、`HOST_CAPABILITY_COMMANDS` 和函数 `dispatchNamedCommand`。`createTelegramController` 中 `getTuiMode` 的缺省值是 `"commands"`，该模式下交互对话框只读。

另外两份文档约定互相矛盾：`README.md` 的 "Interactive modals are Telegram-only during a Telegram turn" 一段，与 full 模式的 `createPromptObserverUi`（画在终端里再镜像出去）。本方案按 §2 原则 3 统一。

---

## 2. 设计原则（实现时必须遵守）

1. **宿主执行，插件不重写。** 除 `pluginOnly` 命令外，命令文本交给宿主的提交处理器执行。插件不保留重做宿主功能的原生实现；桥接不可用时启动报错（§0.1）。
2. **读结构化数据，不读画面。** 数据来源依次是：入口方法的参数 → 宿主方法的返回值 → 组件对象上的字段 → 最后才是只读截图。任何层级都**禁止**用正则解析渲染出来的文本来生成可操作按钮。例外只有 §4.6.6 列出的两种（pi-goal 的不透明 `custom()` 组件；OMP 入口对话框的当前行定位），都有严格限制。
3. **谁发起，谁显示；共享所有权，先操作者生效。** Telegram 发起的对话框：Telegram 显示，终端也会显示（宿主画的），任一端完成操作，另一端立即关闭或显示"已在另一端处理"。本地发起的对话框：只在终端。终端上的变化不主动同步到 Telegram。
4. **操作走组件自己的输入处理。** Telegram 上的选择翻译成：先设置组件的结构化状态（比如 `selectedIndex`），再对**焦点对象**调用 `handleInput("\r")`。不去猜私有回调的参数签名。
5. **识别不了就明确告知，永不卡死。** 识别失败时不降级、不给半吊子操作：在 Telegram 明确告知并只提供"取消"（Esc）（§0.1 第 3 条）。任何 Telegram 端的等待都必须能被终端端的完成、宿主超时或 `/stop` 打断。
6. **不覆盖本地草稿。** 从 Telegram 提交命令前保存本地编辑器内容，在命令 scope 结束时按 §4.2.4 的规则恢复。
7. **hook 不得影响宿主。** 所有包装函数先调用原方法、原样返回结果，插件逻辑全部包在 `try/catch` 中。

---

## 3. 总体架构

```
                   ┌──────────────────────────── 宿主进程（pi / OMP 交互模式）────────────────────────────┐
 Telegram 消息 ──▶ │  CommandGateway ──submit──▶ editor.onSubmit（宿主自己的命令分发）                    │
                   │     │ 开启 scope                     │                                               │
                   │     ▼                                ▼                                               │
                   │  OriginTracker ◀──────┐      宿主执行命令 ─┬─▶ showStatus / showError / showWarning   │
                   │     ▲                 │                    │         │ (原型 hook)                    │
                   │     │ Telegram turn   │                    │         ▼                                │
                   │     │ (UI 栈顶)       │                    │   OutputCapture ──────────▶ Telegram 文本 │
                   │                       │                    ├─▶ chatContainer.addChild (实例 hook)     │
                   │                       │                    └─▶ ui.setFocus / showOverlay (实例 hook)  │
                   │                       │                               │                              │
                   │                       │                               ▼                              │
                   │                       └───────────────── FocusTracker：分类焦点对象                  │
                   │                                                       │ dialog / progress           │
                   │                                                       ▼                              │
                   │                                     DialogBroker（单一活动会话）                     │
                   │                                       AdapterRegistry → DialogModel                  │
                   │                                                       │                              │
 Telegram 按钮 ◀── │                                       TelegramDialogRenderer                         │
 Telegram 回调 ──▶ │  Broker.act() ──▶ adapter.act() ──▶ 焦点对象.handleInput("\r") 等                     │
                   └──────────────────────────────────────────────────────────────────────────────────────┘
```

模块划分（新建目录 `lib/tui/`）：

| 模块 | 文件 | 职责 |
|---|---|---|
| HostAdapter | `lib/tui/host.ts` | 捕获宿主对象，安装 hook，`HostCapabilities` |
| FocusTracker | `lib/tui/focus.ts` | 包装 `setFocus`/`showOverlay`/`hideOverlay`，分类焦点对象，发出事件，校验焦点 |
| OriginTracker | `lib/tui/origin.ts` | 判断当前焦点、输出属于哪个 Telegram 会话 |
| CommandGateway | `lib/tui/gateway.ts` | 命令分发优先级、提交、草稿保护、终端专属映射、enqueued turn 持有 |
| OutputCapture | `lib/tui/output.ts` | 截获命令输出，转成 Telegram 文本 |
| DialogBroker | `lib/tui/broker.ts` | 对话框会话状态机、先操作者生效、Telegram 文本输入接入 |
| Model | `lib/tui/model.ts` | DialogModel、DialogAction 类型 |
| Adapters | `lib/tui/adapters/*.ts` | 从焦点对象读出 DialogModel，并把操作写回 |
| Renderer | `lib/tui/render-telegram.ts` | DialogModel → Telegram 消息和键盘；回调编解码 |
| Snapshot | `lib/tui/snapshot.ts` | 只读截图兜底（从 `tui-bridge.ts` 的 `renderScreen` 迁移） |
| Probe | `lib/tui/probe.ts` | 阶段 0 的宿主探测（§6 阶段 0） |
| SecretStore | `lib/tui/secrets.ts` | 密钥登记与源头脱敏（§4.7.4） |

---

## 4. 模块详细设计

### 4.1 HostAdapter 与 FocusTracker

#### 4.1.1 两种打补丁方式

1. **原型补丁**：针对能 import 到的类（`InteractiveMode`）。沿用 `tui-bridge.ts` 中现有的 `patchMethod`。插件和宿主拿到的是同一个模块实例，这一点已被现有端到端测试证明。
2. **实例补丁**：针对运行时捕获到的对象（`mode.ui`、`mode.chatContainer`、`mode.editor`、`mode.session`）。直接替换实例上的方法，并给包装函数打上标记，防止重复包装。
   - **控件层一律只用实例补丁加形状判断，不 import `@earendil-works/pi-tui` 或 `@oh-my-pi/pi-tui`。** 原因：插件和宿主可能各自加载了一份 pi-tui（本仓库就嵌套了一份 `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`），`instanceof` 和原型补丁会失效；OMP 是编译后的单文件，内部模块不保证能 import。

```ts
// lib/tui/host.ts
type Hooked<F> = F & { __ptpHook?: true; __ptpOriginal?: F };

export function wrapMethod<T extends object>(
  target: T,
  name: string,
  wrap: (original: (...a: unknown[]) => unknown) => (this: unknown, ...a: unknown[]) => unknown,
): boolean {
  const current = (target as Record<string, unknown>)[name];
  if (typeof current !== "function" || (current as Hooked<Function>).__ptpHook) return false;
  const wrapped = wrap(current as (...a: unknown[]) => unknown) as Hooked<Function>;
  wrapped.__ptpHook = true;
  wrapped.__ptpOriginal = current as Function;
  (target as Record<string, unknown>)[name] = wrapped;
  return true;
}
```

**实例 hook 会变旧。** 宿主会在运行中替换被 hook 的对象，而这些替换不会再触发 `init`/`run`/`setupEditorSubmitHandler`，所以不能只依赖 `captureMode`：

- `setCustomEditorComponent`（L1830-1888）用扩展提供的新编辑器替换 `mode.editor`，并 `setFocus(newEditor)`；它把 `defaultEditor.onSubmit` 复制给新编辑器（L1841）。
- `/new`、`/resume`、`/fork` 会替换 `mode.session`。

规则：

1. **提交 hook 打在 `mode.defaultEditor.onSubmit` 上**（不是 `mode.editor.onSubmit`）。宿主替换编辑器时复制的就是它，所以包装后的版本会被一起带过去。
2. **每秒一次的 tick**（与 §4.1.3 的焦点校验共用一个定时器）检查 `mode.editor`、`mode.session`、`mode.ui`、`mode.chatContainer` 是否换了对象，换了就对新对象重新安装实例 hook（`wrapMethod` 靠标记防止重复包装）。
3. tick 在 mode 捕获后启动，只要插件在运行就一直存在；它的开销只是几次引用比较。

#### 4.1.2 Hook 点总表

| 用途 | pi 0.81.1（`dist/modes/interactive/interactive-mode.js`） | OMP 18.12.5 | 方式 |
|---|---|---|---|
| 捕获 mode | `init` / `run` / `setupEditorSubmitHandler`（现有） | `initHooksAndCustomTools` / `render`（现有） | 原型 |
| 命令提交 | `mode.defaultEditor.onSubmit`（与 `mode.editor` 同一实例；`setupEditorSubmitHandler`，L2085 装上） | `mode.editor.onSubmit`（没有 `defaultEditor`；阶段 0 探测时该字段在捕获阶段还是 `undefined`，初始化后才赋值，所以必须由每秒 tick 安装） | 实例 |
| 焦点 | `ui.setFocus(c)`；当前焦点读 `ui.focusedComponent`。阶段 0 证明它是普通数据字段且**滞后一次事件**（`setFocus` 返回后读到的是上一个焦点），只能用于校验；焦点事件本身是权威。overlay 的 `setFocusInternal` 收到 `{component, overlayFocusRestore}` 包装，分类前取 `.component` | `ui.setFocus(c)`；当前焦点读 `ui.getFocused()`（存在且返回实时焦点）；没有 `focusedComponent` | 实例 |
| 扩展命令的执行 | `mode.session.prompt(text)`：空闲时 `onSubmit` 只是把文本交给主循环（`onInputCallback`，L2262 → `getUserInput` L2817），主循环再 `await this.session.prompt(userInput)`（L653） | `mode.session.prompt(text)` 存在；`session.isStreaming`/`isCompacting` 是 accessor；没有 `mode.pendingUserInputs`（§4.3 的 OMP 分支） | 实例（§4.3 的完成信号） |
| 聊天区重建 | `chatContainer.clear()` | 同名 | 实例（§4.4 排除历史重绘） |
| 浮层 | `ui.showOverlay(c, opts)` / `ui.hideOverlay()` | 同名（OMP `/settings` 用浮层） | 实例 |
| 状态输出 | `showStatus`（L2563）、`showError`（L3180）、`showWarning`（L3185） | 同名 | 原型 |
| 其他输出 | `chatContainer.addChild(c)` | 同名 | 实例 |
| 导出结果 | `session.exportToHtml(path)` / `session.exportToJsonl(path)`；阶段 0 证明返回 **Promise**，路径取解析值（探测文件的 `export-resolved`） | `session.exportToHtml(path, false)` 存在，同样返回 Promise | 实例（仅在 `/export` 的 scope 内生效） |
| 扩展选择入口 | `showExtensionSelector(title, options, opts)`（L1712） | UI 上下文的 `select(title, options, opts)`（内部 `showCollabAwareSelector`） | 入口 hook 包 **UI 上下文**，不是 mode 原型 |
| 扩展确认 | `showExtensionConfirm(title, message)`（L1752，内部复用 selector，选项 `["Yes","No"]`） | UI 上下文的 `confirm(title, message, opts)`（内部 `showHookConfirm`） | 同上 |
| 扩展输入 | `showExtensionInput(title, placeholder, opts)`（L1763） | UI 上下文的 `input(title, placeholder, opts)`（内部 `showHookInput`）；没有 `inputSecret` | 同上 |
| 扩展编辑器 | `showExtensionEditor(title, prefill)`（L1803） | UI 上下文的 `editor(title, prefill, opts)`（内部 `showCollabAwareEditor`） | 同上 |
| 扩展 custom | `showExtensionCustom(factory, options)`（L1903） | UI 上下文的 `custom(factory, options)`（内部 `showHookCustom`） | 同上 |
| OMP ask | — | 工具 UI 上下文的 `askDialog(questions, options)`：第一参数是问题数组（`id/question/header/options/recommended`），第二参数是 `{timeout, signal, acceptImages}`；焦点组件只有 `callbacks`/`options`，答题状态在闭包里 | 上下文 hook |
| OMP approve | — | 工具 UI 上下文的 `approve({full, compact, session})`：三个字符串；焦点组件只有 `callbacks{onApprove,onDeny}` / `options{fullPrompt,...}` | 上下文 hook |
| 编辑器本地输入 | `mode.editor.handleInput`（判断本地用户是否在打字，§4.2.4）；编辑器被替换时由 tick 重新包装 | 同名 | 实例 |

阶段 0 结论（2026-10-23，探测文件 `docs/host-probe/`）：OMP 的扩展入口**不在 `InteractiveMode` 原型上直接触发**，扩展和工具通过各自的 UI 上下文调用（`select`/`confirm`/`input`/`editor`/`custom`，工具上下文另有 `askDialog`/`approve`）。只包 mode 原型会漏掉扩展对话框。OMP 的组件类名被压缩（`Ww`、`Ej`、`kj` 等），适配器**禁止用类名匹配**，必须用形状/字段或入口参数；同一版本内类名稳定，跨版本不稳定。

**入口信息与焦点对象的关联**：入口方法 hook 记录语义信息（`EntryInfo`：kind、标题、原始选项、问题列表），关联方式如下，不使用时间窗口：

- 同步入口（`showExtensionSelector`、`showExtensionInput`、`showExtensionEditor`）：宿主在入口方法内部同步创建组件并 `setFocus`。hook 在调用原方法前把 entry 压入 `entryStack`，`setFocus` hook 看到新的 dialog 焦点时取栈顶 entry，存入 `WeakMap<object, EntryInfo>`（键是焦点对象）。出栈写在 `finally` 中，原方法抛异常时也会出栈，避免过期 entry 被下一个焦点事件误用。
- **嵌套入口合并**：`showExtensionConfirm` 内部调用 `showExtensionSelector`。内层 hook 发现栈顶已有外层 entry 时，只补充字段（例如原始选项），**不覆盖** `kind`，所以最终 kind 是 `confirm`。
- 异步入口（`showExtensionCustom`）：宿主先 `await factory(...)`，之后才 `showOverlay`/`setFocus`（L1943-1959），慢工厂可能耗时很久。hook 把 entry 记在本次调用的闭包里，并包装传入的 `factory`：工厂返回的组件（或 promise 解析出的组件）直接写入 `WeakMap<component, EntryInfo>`。焦点事件发生时，先按焦点对象查，再按根组件查。

#### 4.1.3 焦点对象分类

焦点变化有三条路径，都要覆盖：

1. `ui.setFocus(x)`：主路径，实例 hook。
2. `ui.showOverlay(x, opts)`：只有非 `nonCapturing` 且可见时才会内部调用 `setFocus`（pi-tui `tui.js` 中 `showOverlay`），所以 hook `setFocus` 已覆盖。
3. **绕过 `setFocus` 的路径**：pi-tui 的输入处理中，"获得焦点的浮层已不可见"这一分支会调用私有的 `setFocusInternal`（`tui.js` 约 L590），实例 hook 抓不到。（`hideOverlay` 调用的是公开的 `setFocus`，已被覆盖。）

因此 FocusTracker 除了事件驱动，还要做**校验**：在以下时机读一次当前焦点（读法见 §4.1.2），与 Broker 记录的焦点对象比较，不一致就按"焦点变化"处理：

- 每次处理 Telegram 回调或文本输入之前；
- 每次 OutputCapture 收到输出时；
- 每秒一次的 tick（§4.1.1）。

阶段 0 探测补充：pi 的 `ui.focusedComponent` 在 `setFocus` 返回后读到的仍是**上一个**焦点（普通数据字段，不是实时 getter）。所以校验读取只用来发现"绕过 `setFocus` 的内部切换"；当前焦点以最近一次 `setFocus`/`setFocusInternal` 事件为准。overlay 路径的 `setFocusInternal` 收到 `{component, overlayFocusRestore}` 包装对象，分类前先取 `.component`。OMP 的 `ui.getFocused()` 是实时读取，且所有对话框都经过 `setFocus`，没有观察到包装对象。

焦点对象 `F` 的分类（按顺序判断，第一个命中即止）：

| 分类 | 判断 | 处理 |
|---|---|---|
| `editor` | `F === mode.editor` 或 `F === mode.defaultEditor` | 关闭当前会话（如有），但**焦点交回编辑器必须是持续的**：同一组件在确认窗口（250ms）内重新拿到焦点就取消这次关闭。OMP 重绘已打开的 overlay 时会把焦点交回编辑器一帧，按单次事件判定会在作答途中撤掉 Telegram 键盘并把聊天让给镜像（决定 28） |
| `inert` | `F` 没有 `handleInput` 函数 | 忽略（例如 `/reload` 的 `reloadBox`，它是一个只显示文字的容器） |
| `progress` | `F.constructor.name` 以 `Loader` 结尾，或 `F` 有 `signal`/`abortController` 且没有任何列表、输入字段（按 §4.6.3 的 `findShape` 查找） | 进度状态，不是对话框：broker 不为它建会话、不发 Telegram 消息，终端镜像照旧显示画面。原设计的"发'⏳ 进行中'并只给取消按钮"实测有害：OMP 的 working spinner 一出现就在聊天里占住一条带键盘的消息，把用户发给下一个（还没建起来的）对话框的文本吃掉，那条文本永远到不了模型；中断仍由 `/stop` 与镜像按键覆盖（决定 28）。例：`/share` 的 `BorderedLoader`（L4613） |
| `dialog` | 其他 | 交给 AdapterRegistry |

**会话身份以焦点对象 `F` 为准。** 宿主的 `showSelector(create)` 返回 `{ component, focus }`，两者可能不同：`/settings` 的焦点是 `selector.getSettingsList()`（L3583），`/fork` 的焦点是 `selector.getMessageList()`（L3819）。规则：

- `detect` / `read` / `act` 一律针对焦点对象 `F`，向下查找数据。
- 根组件 `root`（`editorContainer.children[0]`，或浮层项的 `component`）只用于向上找标题和入口信息，不用于判断会话是否还活着。
- 输入一律发给 `F.handleInput`，因为宿主就是把按键发给焦点对象的。

#### 4.1.4 宿主能力探测

```ts
type HostCapabilities = {
  host: "pi" | "omp" | "unknown";
  version?: string;
  focusHook: boolean;      // ui.setFocus 已包装
  focusRead: boolean;      // 能读到当前焦点
  overlayHook: boolean;
  outputHook: boolean;     // showStatus/showError/showWarning 至少一个
  submitHook: boolean;
  entryHooks: string[];    // 成功包装的入口方法名
};
```

启动时写入调试日志。`focusHook`、`focusRead`、`submitHook` 任一失败，插件启动直接报错（§0.1），不退回任何其他路径。

### 4.2 CommandGateway

#### 4.2.1 命令目录

沿用 `getTuiCommands()`：OMP 内置注册表 `BUILTIN_SLASH_COMMAND_DEFS`、自动补全列表、`session.slashCommands`/`customCommands`/`promptTemplates`。Telegram 菜单生成和 `/more` 翻页（`menuOverflow`、`moreKeyboard`）保持不变。

运行时计算三个名字集合（每次 mode 重新捕获时刷新）：

- `hostBuiltin`：宿主内置命令名。
  - **pi**：无法从命令目录推导。`buildCommandCatalog` 中 pi 的 `source` 只有 `"autocomplete"` 和 `"host"`（`"builtin"` 只出现在 OMP 的注册表），而且自动补全列表里混有扩展命令和插件自己注册的 6 个命令。所以 pi 的 `hostBuiltin` **直接使用附录 A 的静态列表**，按 pi 版本维护。阶段 0 的自动补全目录仍无法区分内置/扩展（`catalog` 为空），与本判断一致。
  - **OMP**：取注册表 `BUILTIN_SLASH_COMMAND_DEFS`。
- `pluginNative`：插件 `telegramCommands` map 中的全部名字（`index.ts` 中 `registerAllCommands`、`registerTelegramCommands` 注册的）。
- `pluginOnly = pluginNative − hostBuiltin`：只有插件实现、宿主没有内置的命令，例如 `/tg*`、`/stop`、`/status`、`/cwd`、`/cd`。
- 两个**不在 `telegramCommands` 中**的插件特例，在分发第 0 步单独处理（§4.2.2）：`/pair`（在 `authorizeUser` 阶段、命令分发之前就被消费）和 `/more`（`dispatchNamedCommand` 顶部的特殊分支，仅在 bot 菜单溢出时生效）。

注意：`index.ts` 的 `TUI_VISIBLE_COMMANDS`（`tg`、`cwd`、`cd`、`status`、`stop`、`debug`）同时注册给了宿主。其中 `debug` 与 pi 内置的 `/debug` 重名，pi 的 `onSubmit` 中内置分支先匹配，所以在终端里执行的是 pi 内置版本。按下面的优先级，Telegram 上的 `/debug` 也会走宿主内置版本，和终端一致。

`pluginOnly` 命令是"所有命令交给宿主执行"的**唯一例外**：它们继续走现有的 `runCommandHandler`（Telegram 原生 UI），因为它们管理的是 Telegram 侧的状态（bot、绑定、配置），宿主里没有对应实现。

#### 4.2.2 分发优先级（替换 `dispatchNamedCommand` 的分流逻辑）

```
收到 Telegram 命令 /name args：
0. 特例：/pair（授权阶段已消费，不会到这里）；/more 且菜单有溢出 → 现有逻辑，不变
0'. 对话框守卫：当前 chat+thread 有 owner 为自己的活动 Broker 会话，或有待输入的流
    （deps.ui.hasPendingInput(chatId, thread)）时：
      name 是 stop   → 取消对话框并执行 /stop（§4.5 规则 6）
      name 是 status → 正常执行（只读）
      其他           → 回复"请先处理当前对话框"，结束
1. name ∈ pluginOnly                 → 插件自己的 handler（现有 runCommandHandler，不变）
2. name 命中终端专属映射表（§4.8）    → 执行映射
3. 桥接可用 且 (name ∈ hostBuiltin 或 name 是宿主扩展命令/模板/技能)
                                       → gateway.submit("/name args", origin)
4. （v6 删除：不再有插件原生兜底 handler，§0.1）
5. 否则                               → 回复"该命令需要在终端执行"
```

"宿主扩展命令"包括其他扩展注册的命令（例如 pi-goal 的 `/goals`、`/sisyphus`）。插件自己注册给宿主的那几个已经在第 1 步处理，不会走到第 3 步。

第 0' 步的守卫对**所有**分支生效（包括 `pluginOnly` 和原生兜底），因为 `pluginOnly` 命令（例如 `/cwd` 的 `ui.select`）会开启 Telegram 原生输入流，与 Broker 的外部输入流共用"最新流"表（§4.5.1），两者并存会互相覆盖。

删除 `TUI_NATIVE_SELECTOR_COMMANDS`、`MIRROR_FIRST_COMMANDS`、`HOST_CAPABILITY_COMMANDS` 三个常量和按命令名分流的逻辑（阶段 3）。

普通文本（不以 `/` 开头）仍走现有的 `runPrompt`，不经过 Gateway。`!`/`!!` bash 保留现有的 `runTelegramBash`。

#### 4.2.3 提交流程

```ts
async function submit(text: string, origin: Origin): Promise<SubmitResult> {
  // 1. 终端正开着对话框（焦点不在编辑器）→ 拒绝
  if (focus.classify(focus.current()) !== "editor") return { ok: false, reason: "dialog-open" };
  // 2. 已有命令 scope 未结束，或该 chat 有待输入的流 → 拒绝
  if (origin.hasActiveCommandScope()) return { ok: false, reason: "busy" };
  if (deps.ui.hasPendingInput(origin.chatId, origin.messageThreadId)) return { ok: false, reason: "input-pending" };
  // 3. 保存草稿并开启 scope
  const draft = readEditorText();                              // getExpandedText?.() ?? getText()
  const scope = originTracker.beginCommand(origin, text, draft);
  // 4. 在 Telegram turn + 宿主提示模式的 UI 栈中执行（§4.2.6），
  //    并在 agent 原本空闲时持有到 enqueued turn 链结束
  const run = () => {
    // 必须先登记再调用：流式/压缩路径的 session.prompt 在 onSubmit 内部同步发生
    if (gateway.isHostBuiltin(text)) scope.promptDone = true;   // 内置命令不会调用 session.prompt
    else promptTracker.expect(scope, text);                    // §4.3：扩展命令、模板、技能
    // 只在同步分发期间抑制"本地提交"监听；onSubmit 返回的 promise 不在抑制范围内
    return withSuppressedLocalSubmit(() => mode.defaultEditor.onSubmit(text));
  };
  scope.submitPromise = runAsTelegramCommand(origin, run);    // 不 await，见下
  scope.submitPromise.finally(() => originTracker.markSubmitDone(scope));
  return { ok: true };
}
```

要点：

- **不调用 `editor.setText(text)`**。现有 `submitToHost` 先 `setText(text)` 再提交，会覆盖本地草稿，这是现有 bug。
- `withSuppressedLocalSubmit` 只包住**同步调用**那一刻（防止插件自己的提交被当成本地输入），不能包住整个 `await`。否则 `/compact` 这类命令执行的几分钟里，本地用户敲的命令都会被漏掉。阶段 5 删除旧的本地命令镜像后（§4.9 第 5 条），这个抑制机制可以一并删除。
- 不调用 `editor.addToHistory`，避免污染本地输入历史。
- 调用方不能 `await` 整个流程：`onSubmit` 可能挂起很久（`/compact` 几十秒），会阻塞 Telegram 轮询。
- `onSubmit` 什么时候返回取决于命令。pi 0.81.1 `setupEditorSubmitHandler` 中：
  - **await 型**（返回时命令已完成）：`/scoped-models`、`/model`、`/export`、`/import`、`/share`、`/copy`、`/clone`、`/login`、`/clear`（即 `/new`）、`/compact`、`/reload`。
  - **立即返回型**（打开对话框后马上 return，之后由对话框回调异步完成）：`/settings`、`/name`、`/session`、`/changelog`、`/hotkeys`、`/fork`、`/tree`、`/trust`、`/logout`、`/debug`、`/resume`、彩蛋命令。
  - **扩展命令、模板、技能**：空闲时 `onSubmit` 只是把文本交给主循环就返回了，真正的执行在主循环的 `session.prompt` 里（§4.1.2 "扩展命令的执行"一行）。流式和压缩中，`onSubmit` 会直接 `await session.prompt(...)`。
  - 所以 scope 的结束不能只看 `onSubmit`，见 §4.3。

#### 4.2.4 草稿保护

草稿 `D` 在提交前保存（§4.2.3 第 3 步）。**恢复在 scope 结束时进行**（不是在 `submit` 末尾），因为立即返回型命令在 `submit` 返回时焦点还在对话框上。

本地用户可能在焦点回到编辑器后开始打字。FocusTracker 包装 `editor.handleInput`（实例 hook），焦点回到编辑器后只要有一次本地按键，就给 scope 打上 `localEdited = true`。插件自己从不调用 `editor.handleInput`，所以这个标志只代表本地输入。

scope 结束时（§4.3），设当前编辑器内容为 `E`：

| 情况 | 处理 |
|---|---|
| `localEdited` | 什么都不做。本地用户在场并且已经在编辑，编辑器归他 |
| `E === D` | 什么都不做 |
| `E === ""` | `setText(D)`（恢复草稿） |
| `E` 非空且 `≠ D` | 这是宿主为发起者写入的文本（例：`/fork` 选中消息后执行 `this.editor.setText(result.selectedText)`，见 `showUserMessageSelector` L3814）。按"谁发起，谁显示"：把 `E` 作为一条消息发到 Telegram（标注"已放入编辑器的文本，可复制修改后发送"），然后 `setText(D)` 恢复本地草稿 |

#### 4.2.5 兜底路径

**v6 取消兜底路径。** `HostCapabilities` 显示不可用时（宿主以 RPC/print 模式运行、宿主升级导致 hook 失败），插件启动直接报错；不保留 `off` 模式，Telegram 原生实现（`lib/commands/*` 中重做宿主功能的部分、`telegram-ui.ts` 中对应的原生对话框流程、`custom-dialogs.ts`）在任务 D1–D4 中删除（§0.1）。

#### 4.2.6 Enqueued turn 的持有

pi-goal 的 `/goals`、`/sisyphus` 这类扩展命令通过 `pi.sendUserMessage` 把 agent turn 放进队列后立即返回，真正弹对话框（`goal_question`、`propose_goal_draft`、`goal_questionnaire`）是在之后的 turn 里。现有 `runCommandHandler` 的做法是：命令到达时如果 agent 空闲（`ctx.isIdle()`），就在 handler 返回后用 `ctx.waitForIdle()` 循环等待，并在每次空闲后再等 120ms（大于 pi-goal 的 50ms 续跑重试间隔），确认没有新 turn 才结束，期间一直保持 `runWithTelegramTurn` + `runWithTelegramUi`。

**新方案中，扩展命令改为经 `editor.onSubmit` 交给宿主执行，不再经过 `runCommandHandler`，所以这段持有逻辑会被跳过。必须这样处理：**

1. 把 `runCommandHandler` 中的持有逻辑抽成共享函数 `holdThroughEnqueuedTurns(ctx, wasIdle)`，`runCommandHandler` 和 Gateway 都调用它。
2. Gateway 的 `runAsTelegramCommand` 借用 `runCommandHandler` 的**持有逻辑**，但 **UI 模式不同**：
   - `runCommandHandler` 调 `runWithTelegramUi` 时不传 `observePrompts`，于是使用默认的 `createRoutedTelegramUi`，扩展的 `ctx.ui.select/confirm/input` 会走 Telegram 原生 UI。这是 `pluginOnly` 命令和 `off` 模式需要的行为，保持不变。
   - Gateway 必须让提示交给**宿主 UI** 绘制，由 Broker 接管。把 `runWithTelegramUi` 的 `observePrompts?: () => void` 参数改为 `uiMode: "telegram-native" | "host"`：`"telegram-native"` 用 `createRoutedTelegramUi`；`"host"` 用 §4.9 简化后的 `createHostPromptUi`（由 `createPromptObserverUi` 改名而来）。
   - 代码：`runWithTelegramTurn(turn, () => runWithTelegramUi({ session, ui, turn, uiMode: "host", run: async () => { await run(); await holdThroughEnqueuedTurns(ctx, wasIdle); } }))`，`wasIdle` 在提交前读取。
   - `runPrompt` / `runMainDelivery`（普通文本）在 `on` 模式下同样传 `uiMode: "host"`，`off` 模式传 `"telegram-native"`。
3. 持有期间，对话框按 §4.3 规则 2（Telegram UI 栈顶）归属该 chat。
4. 宿主内置命令（`/model` 等）也走同一包装：对不会产生 turn 的命令，`holdThroughEnqueuedTurns` 发现 agent 一直空闲就会立即结束，没有额外代价。

验收（阶段 2）：从 Telegram 发 `/goals <topic>`，agent 调 `propose_goal_draft` 时 Telegram 收到确认按钮（与现在 README 宣传的能力一致）。

### 4.3 OriginTracker（这次操作属于谁）

```ts
type Origin = { chatId: number; messageThreadId?: number; sourceMessageId?: number };

type CommandScope = {
  id: string;                     // 自增，base36
  origin: Origin;
  label: string;                  // 例如 "/model"
  draft: string;                  // §4.2.4
  localEdited: boolean;
  submitPromise?: Promise<void>;
  submitDone: boolean;            // submitPromise 已结束（含持有）
  promptExpect?: { text: string; startedAt: number; quietSince?: number };   // 等待匹配的 session.prompt
  promptPromise?: Promise<unknown>;                  // 匹配到的那次 session.prompt
  promptDone: boolean;            // 没有匹配到，或匹配到的 prompt 已结束
  lastOutputAt: number;
  telegramMessageId?: number;     // scope 复用的 Telegram 消息
};
```

对话框和输出的归属，按顺序判断：

1. **活动的命令 scope** → 归该 scope 的 chat。
2. **Telegram UI 栈非空**（`controller.ts` 中 `telegramUiStacks.get(runner)` 的栈顶有条目）→ 归栈顶条目的 `turn.chatId/messageThreadId`。这覆盖 Telegram 发起的普通 agent turn 和 §4.2.6 的持有期间。用 UI 栈而不是 `getCurrentTelegramTurn()`（AsyncLocalStorage）判断，因为宿主的对话框回调不一定运行在插件的异步上下文里，而 UI 栈是全局状态，现有的 goal 对话框路由正是依赖它。为此 controller 需要导出一个只读函数 `getTopTelegramTurn(runner)`。
3. **都没有** → 本地发起：不推送到 Telegram。Broker 仍然记录会话（第 0' 步守卫和 §4.2.3 第 1 步的焦点检查会据此拒绝 Telegram 提交），但不发任何消息。

"owner 相同"一律按 `chatId + messageThreadId` 比较，不按 `Origin` 对象引用比较。

**第二个完成信号：匹配 `session.prompt`。** 扩展命令在空闲路径上，`onSubmit` 返回时 handler 可能还没开始执行（§4.2.3）。规则：

- **只对非内置命令登记**（扩展命令、模板、技能；判断依据是 §4.2.1 的 `hostBuiltin`）。内置命令提交时直接 `promptDone = true`，不等待，scope 可以立即进入其他结束条件的判断。
- 实例 hook `mode.session.prompt`（session 被替换时由 tick 重新包装）。
- **先登记，再调用 `onSubmit`**（§4.2.3）。流式和压缩路径中，`onSubmit` 内部同步调用 `session.prompt`，晚于登记就会错过。
- 登记之后，第一次参数（去掉首尾空白后）等于 `text` 的 `session.prompt` 调用就是本次提交引起的：记录其 promise 到 `promptPromise`，结束后置 `promptDone = true`。
- **过期条件不按固定时间**：主循环可能正忙（上一轮收尾、`pendingUserInputs` 排队），文本要等循环回到 `getUserInput` 才变成 `session.prompt`，耗时不确定。没有匹配时，只有以下三点**连续保持 500ms** 才判定"不会再来"并置 `promptDone = true`：
  - session 空闲（`isStreaming` 和 `isCompacting` 都为假）；
  - `mode.pendingUserInputs` 为空；
  - 主循环正停在 `getUserInput`（`mode.onInputCallback` 已设置）。

  `quietSince` 记录这三点开始同时成立的时间，任一点不成立就清空。另设 60 秒上限，防止宿主字段变化导致永远等待（上限触发时记警告日志）。这三个字段是 pi 0.81.1 的私有字段（L2817-2826）。**OMP 18.12.5（阶段 0 探测）**：`session.isStreaming`/`isCompacting` 是 accessor，`mode.onInputCallback` 存在，但**没有** `mode.pendingUserInputs`；OMP 只有在 `onInputCallback` 是函数且前两个 accessor 都为假时才开始计 `quietSince`，连续 500ms 后结束，另设 60 秒上限。读不到字段时直接退回 60 秒上限。

**命令 scope 的结束条件**（全部满足）：

- `submitDone && promptDone`；
- Broker 没有活动会话；
- 当前焦点分类为 `editor`；
- 距最后一次输出超过 `IDLE_MS = 1500`。

这样，await 型的长任务（`/compact`、`/share`、`/new`）靠 `submitDone` 兜住，完成时的输出不会丢；扩展命令靠 `promptDone` 兜住；立即返回型的对话框命令（`/settings`、`/resume`）靠"有活动会话"兜住；多步对话框（`/login` 的"认证方式 → 服务商 → 输入"之间短暂回到编辑器）靠 `IDLE_MS` 吸收。

**安全上限 `SCOPE_MAX_MS = 30 分钟`**：

- 超时时如果 Broker 仍有属于该 scope 的活动会话，**不结束**，每次延长 30 分钟（对话框还开着，说明用户可能还会操作）。
- 没有活动会话时才强制结束：释放 scope，**跳过草稿恢复**（此时无法判断编辑器内容的来源），记一条警告日志。不动宿主。

正常结束时执行 §4.2.4 的草稿处理，然后释放 scope。

### 4.4 OutputCapture

**内容域划分**（必须遵守，否则会双发）：

| 内容 | 唯一负责方 |
|---|---|
| agent 的消息、思考、工具调用及结果 | 现有 `lib/renderer.ts`（通过 `agent_start`、`tool_execution_*`、`message_end` 等事件）。宿主在 turn 期间往 `chatContainer` 加的 `AssistantMessageComponent`、`ToolExecutionComponent`（L2330、L2406、L2663、L2700）**一律不截获** |
| 宿主的状态、错误、警告（`showStatus`/`showError`/`showWarning`），包括扩展 `notify` 经宿主转成的状态 | OutputCapture |
| 命令产生的其他聊天区内容（例如 `/session` 的信息块、`/changelog`、压缩摘要） | OutputCapture，但只在下表的条件下 |

截获规则：

| 来源 | 何时截获 | 转换 |
|---|---|---|
| `showStatus(msg)` | 归属为 Telegram（§4.3 规则 1 或 2） | 纯文本。pi 会原地更新上一条状态（`showStatus` L2563-2570），同一 scope 内的连续状态编辑同一条 Telegram 消息 |
| `showError(msg)` / `showWarning(msg)` | 同上 | 加 `❌` / `⚠️` 前缀 |
| `chatContainer.addChild(c)` | **同时满足**：① 有活动的**命令 scope**（§4.3 规则 1；只有规则 2 归属的 turn 期间不截获）；② 不在聊天区重建中（见下）；③ `c` 不是 agent 渲染的组件（见下）。**不用 `isStreaming` 粗筛**：pi 的 `onSubmit` 中 `/session`、`/changelog`、`/debug`、`/name` 等分支在流式检查（L2248）之前，agent 流式时从 Telegram 发这些命令，宿主照样往聊天区加内容，必须截获 | 有字符串 `text` 字段（Text）→ 去掉颜色码；Markdown 组件（有 markdown 原文字段）→ `lib/markdown.ts` 转 Telegram HTML；其他 → `c.render(80)` 去色后放进 `<pre>`，超长用 `splitTelegramText` 切分 |

- **聊天区重建**：`/resume`、`/fork`、`/new` 会先 `chatContainer.clear()`，再用 `addChild` 把整段历史重新加一遍。实例 hook `chatContainer.clear`：调用后设置 `rebuilding = true`，直到下一个宏任务（`setTimeout(0)`）才清除；期间的 `addChild` 一律不截获。会话历史在 Telegram 上由现有的历史回放功能负责，不归 OutputCapture。
- **agent 渲染的组件**（满足任一即排除）：
  - `c === mode.streamingComponent`；
  - `c.constructor.name` 匹配 `/MessageComponent$/`（`AssistantMessageComponent`、`UserMessageComponent` 等）或等于 `ToolExecutionComponent`、`BashExecutionComponent`；
  - `c` 有 `lastMessage`、`hasToolCalls`、`toolCallId` 中任一自有字段。

  pi 0.81.1 核对过的字段：`AssistantMessageComponent` 有 `lastMessage`、`hasToolCalls`，没有 `message`；`UserMessageComponent` 只有 `text`，靠构造器名识别。
  **OMP 18.12.5（阶段 0 探测）**：聊天区组件只暴露 `children`，没有 `lastMessage`/`hasToolCalls`/`toolCallId`。观察到的 agent 渲染构造器：`qs`（用户消息）、`_Te`（助手消息）、`Aw`（工具块）、`Ds`（流式组件，且 `c === mode.streamingComponent`）；`j`/`w` 是布局/文本原语，命令输出也会用，不能单独作为排除依据。排除规则用"这组构造器名 + `c === mode.streamingComponent`"；构造器名是压缩后的，跨 OMP 版本会变，契约测试固定 18.12.5 的集合。
- **每个 scope 最多截获 20 个组件**，超出部分合并为一行"…还有 N 项输出，请在终端查看"。

其他规则：

- 忽略渲染结果全是空行的组件（`Spacer`）。
- 同一 scope 内的输出防抖 700ms 合并成一条消息，发在 scope 的 Telegram 消息之后。
- 去重：`showStatus`/`showError`/`showWarning` 的 hook 在调用原方法期间设置 `inShowX = true`，期间的 `addChild` 跳过。
- 发送前对文本做密钥脱敏（§4.7.4）。
- `notify` 的去重见 §4.9 第 1 条：`on` 模式下 Telegram 副本只由 OutputCapture 发出。

### 4.5 DialogBroker

终端同一时刻只有一个获得焦点的对象，所以 Broker 只维护**一个**活动会话。

```ts
type DialogSession = {
  id: string;                       // base36 自增
  generation: number;               // 每次 Telegram 端重绘 +1
  focus: object;                    // 焦点对象 F（会话身份）
  root?: object;                    // 根组件，只用于找标题
  kind: "dialog" | "progress";
  adapter?: DialogAdapter;
  model: DialogModel;
  owner?: Origin;                   // §4.3 的归属；undefined = 本地，不推送
  telegram?: { chatId: number; messageThreadId?: number; messageId: number };
  pendingInput?: { flowId: string; secret: boolean; purpose: "input" | "editor" | "search" | "type" };
  keyMap: Map<number, Map<number, string>>; // generation → 页内序号 → item.key；只保留最近 3 代
  state: "open" | "resolving" | "closed";
  closedBy?: "telegram" | "terminal" | "replaced";
  lastAction?: string;              // 用于关闭时的摘要
};
```

状态机：

```
            焦点 = dialog                Telegram 操作
  (无) ───────────────▶ open ─────────────────────────▶ resolving ──(焦点离开 F)──▶ closed[telegram]
                         │  ▲                              │
                         │  └──(操作后焦点仍是 F：翻页、搜索、勾选、设置切换、子菜单)──┘
                         ├──(焦点离开 F，非 Telegram 引起)──▶ closed[terminal]
                         └──(焦点变为另一个 dialog)────────▶ closed[replaced] → 新会话 open
```

规则：

1. **打开**：FocusTracker 报告 `dialog` 焦点。按 §4.1.2 取出关联的 `EntryInfo`，依次询问 AdapterRegistry，取第一个 `detect()` 为真的适配器，`read()` 得到 DialogModel；都不命中用 SnapshotAdapter。按 §4.3 确定 `owner`。`owner` 为空时不发 Telegram 消息。
2. **重绘时机**（终端上的变化不同步）：
   - Telegram 端操作后焦点仍是 `F`：重新 `read()`，`generation+1`，编辑消息；
   - 同一 owner 下焦点换成另一个 dialog：owner 来自**命令 scope** 时，新会话原地编辑同一条消息；owner 来自 **turn**（§4.3 规则 2）时，新会话新发一条消息（turn 中的对话框之间隔着 agent 输出，原地编辑会让消息顺序错乱）。见 §4.7.3；
   - 会话关闭（规则 4）。
   - 每 chat 编辑频率上限 1 次/秒，模型无变化不编辑。
3. **Telegram 操作**（回调或文本输入）：
   1. 先做焦点校验（§4.1.3）。
   2. 会话已关闭或 `sessionId` 不匹配 → `answerCallbackQuery("已在终端处理")`，移除该消息键盘。
   3. `generation` 过期 → 用最新模型重绘，提示"列表已变化，请重新选择"。
   4. 重新 `read()` 拿到实时模型，按 `item.key` 在实时列表中查找目标（不按下标）：找不到 → 重绘并提示"列表已变化"，不执行。
   5. 找到 → `state = "resolving"`，`adapter.act(F, action)`，然后 `ui.requestRender()`，再做一次焦点校验以决定是 `open`（重绘）还是 `closed`。
4. **关闭**（焦点离开 `F` 时，按新焦点的分类决定，优先级从高到低）：
   1. **新焦点是另一个 dialog，且 owner 相同，且 owner 来自命令 scope**（例如 `/login` 多步，Telegram 操作后宿主直接切到下一步）→ `closedBy = "replaced"`，**不写摘要**，新会话直接在同一条消息上绘制。无论旧会话是否处于 `resolving` 都如此。（owner 来自 turn 时不适用本条，按 2、3 写摘要后新会话另发消息。）
   2. 旧会话处于 `resolving` → `closedBy = "telegram"`，消息改为"✅ <lastAction 摘要>"（密钥类输入只写"✅ 已提交（内容已隐藏）"）。
   3. 否则 → `closedBy = "terminal"`，消息改为"已在终端处理"，移除键盘。
   - 有 `pendingInput` 时同时注销文本输入（§4.5.1）。
5. **超时**：Broker 不设超时，由宿主负责（宿主对话框有自己的 `timeout` 选项）。会话关闭时 Telegram 端的等待随之结束，不会卡死。
6. **`/stop`**：如果有 owner 为该 chat 的活动会话，先 `adapter.act(F, { type: "cancel" })`（发 Esc），再执行原有 `/stop` 逻辑。
7. **progress 会话**：只有"取消"按钮（发 Esc 给 `F`）。它和 dialog 一样有关闭流程：
   - 焦点离开时，消息编辑为"✅ 完成"（经 Telegram 取消的为"已取消"），移除键盘；
   - 在命令 scope 中，progress 使用 scope 的消息；之后同一 scope 的对话框按规则 4.1 原地复用这条消息（progress 视同 dialog 参与"替换"判断）；
   - 后续输出由 OutputCapture 作为新消息发送。

#### 4.5.1 Telegram 文本输入的路由

input、editor、搜索、快照"输入文字"都需要接收用户的下一条文本。规则：

- Broker 进入等待文本状态时，通过 `telegram-ui.ts` 新增的接口注册到现有的输入流表，与 `waitInput` 共用"按 chat + thread 的最新流"机制。这样控制器消息处理中现有的 `deps.ui.resolveInput(chatId, rawText, ...)` 调用会先把文本交给 Broker，不会被当成 prompt。接口：

  ```ts
  // lib/telegram-ui.ts
  registerExternalInput(opts: {
    chatId: number;
    messageThreadId?: number;
    promptMessageId: number;   // 对话框所在的 Telegram 消息 id（DialogSession.telegram.messageId）
    sensitive: boolean;
    onText(text: string): void;
    onCancel(): void;
  }): { flowId: string; dispose(): void };
  ```

  - `flowId` 由 `telegram-ui.ts` 内部的 `beginFlow()` 分配并返回，Broker 只保存它，不自己生成。
  - `promptMessageId` 写入流记录，供现有的 `isSensitiveInput` 和"回复某条消息"定位使用。对话框消息被原地编辑成下一步时 id 不变；Broker 换成新消息时要先 `dispose()` 再重新注册。
  - 外部流**不设超时**：不启动 `INPUT_TIMEOUT_MS`（10 分钟）计时器。生命周期完全由 Broker 控制：会话关闭、`/stop`、或 Broker 调用 `dispose()` 时注销。
  - 流记录增加一个标记 `external: true`，控制器据此执行下表的分类。
- **在 `resolveInput` 之前**，控制器要先对文本分类（仅当该 chat/thread 的最新流是 Broker 注册的外部流时适用；现有 `telegram-ui` 流的行为不变）：

| 收到的文本 | 处理 |
|---|---|
| `/stop` | 取消对话框（规则 6）并执行 `/stop`，注销输入 |
| `pluginOnly` 中的命令（`/tg`、`/status` 等） | 正常执行，输入继续等待 |
| 其他 `/` 命令 | 回复"有对话框正在等待输入，请先回复或取消"，不消费 |
| 直接发送的文本（不是回复），或回复对话框那条消息的文本 | 作为输入交给 Broker |
| 回复**其他**消息的文本 | 不算输入，按普通消息处理（与现有 `resolveInput` 的匹配规则一致：有 `replyToMessageId` 时只匹配 `promptMessageId` 相同的流） |

- 只匹配同一个 thread；其他 thread 的文本不受影响。
- 插件端不设输入超时；宿主关闭对话框时注销输入。
- `sensitive` 为真时，消费后立即删除用户的消息（沿用现有 `isSensitiveInput` + `deleteMessage` 的做法）。
- **实现现状（阶段 2 实测后修正）**：`registerExternalInput` 还没落地，Broker 的等待文本状态与 `waitInput` 仍是两张表。控制器据此排序：先 `deps.ui.resolveInput`（插件在这个 chat 里发起、正等 Telegram 键盘的那条流），再轮到镜像对话框（上表的搜索/输入）。等价于单表模型里"最新流优先"——谁最后问，谁拿答案。不这么排会出实测过的连锁故障：终端里遗留的一个对话框（读不到字段，只有"未适配的对话框"快照镜像）把用户给密钥提示的回答当成搜索词吃掉，那条提示接着把下一条 `/probe-custom` 命令当成自己的回答删掉，两个步骤一起失败。合成一张表（`registerExternalInput`）仍是目标，跟 T3.6 的搜索路由一起做。

### 4.6 DialogModel 与适配器

#### 4.6.1 DialogModel

```ts
type DialogItem = {
  key: string;            // 适配器内稳定的标识（value/id 优先，没有时用"完整列表中的下标 + 标签"）
  label: string;
  description?: string;
  value?: string;         // 设置项的当前值
  current?: boolean;      // 当前生效值（例如当前模型）
  checked?: boolean;      // 多选
  focused?: boolean;      // 读取时终端光标所在行
};

type Question = {
  id: string;
  prompt: string;
  items: DialogItem[];
  multi: boolean;
  allowCustom: boolean;   // 是否允许自由文本答案
  answered: boolean;
};

type DialogModel =
  | { kind: "select"; title: string; items: DialogItem[]; total: number;
      search?: { query: string }; multi?: boolean; extraActions?: { label: string; key: string }[] }
  | { kind: "settings"; title: string;
      items: (DialogItem & { values?: string[]; hasSubmenu?: boolean })[];
      search?: { query: string };
      submenu?: { itemKey: string; model: DialogModel } }          // 子菜单是嵌套状态，见 §4.6.4 #5
  | { kind: "questionnaire"; title: string; questions: Question[]; active: number; canSubmit: boolean }
  | { kind: "approval"; title: string; detail?: string; options: { key: string; label: string }[] }
  | { kind: "confirm"; title: string; message?: string }
  | { kind: "input"; title: string; placeholder?: string; secret: boolean; prefill?: string }
  | { kind: "editor"; title: string; prefill?: string }
  | { kind: "progress"; text: string; cancellable: boolean }
  | { kind: "info"; title?: string; text: string; closable: boolean }
  | { kind: "snapshot"; title?: string; text: string };

type DialogAction =
  | { type: "choose"; key: string }
  | { type: "toggle"; key: string }
  | { type: "cycle"; key: string; value?: string }
  | { type: "submenu"; key: string }
  | { type: "question"; index: number }               // 切换问卷中的问题
  | { type: "search"; query: string }
  | { type: "submit"; text?: string }
  | { type: "confirm"; yes: boolean }
  | { type: "approve"; key: string }
  | { type: "key"; name: string }                     // 组件特有按键；快照只允许 up/down/enter/esc
  | { type: "cancel" };
```

`items` 是完整的（过滤后的）列表，不是终端当前可见的那一屏。分页在 Telegram 端完成。

#### 4.6.2 适配器接口

```ts
interface DialogAdapter {
  id: string;
  /** 只用形状判断，禁止 instanceof。F 是焦点对象。 */
  detect(F: object, ctx: AdapterContext): boolean;
  read(F: object, ctx: AdapterContext): DialogModel;
  /** 返回 false 表示无法执行；Broker 会提示失败并重绘，不会改用其他方式猜测。 */
  act(F: object, action: DialogAction, ctx: AdapterContext): boolean;
}

type AdapterContext = {
  host: "pi" | "omp";
  root?: object;
  entry?: EntryInfo;        // 入口 hook 记录的语义信息
  sendKey(name: string): boolean;   // 发给 F.handleInput
  requestRender(): void;
};
```

#### 4.6.3 向下查找数据：`findShape`

数据不一定在焦点对象本身上，也不一定在 `children` 里。例：`SessionSelectorComponent` 的 `filteredSessions`、`selectedIndex`、`searchInput` 都在它的字段 `sessionList` 上，而 `SessionList` 是普通类，不是组件，不在 `children` 中（pi `session-selector.js` 的 `class SessionList`，L228）。

```ts
function findShape<T>(start: object, test: (o: any) => o is T, maxDepth = 3): T | undefined
```

- 从 `F` 开始广度优先遍历对象的**自有可枚举字段**（不限于 `children`），数组只展开元素是对象的。
- 用 `WeakSet` 防环。
- 只跳过通向**宿主全局状态**的字段名：`tui`、`ui`、`theme`、`keybindings`、`session`、`settingsManager`、`modelRuntime`、`terminal`。环由 `WeakSet` 处理，不需要再跳过 `parent`。**不跳过 `editor`**：`ExtensionEditorComponent` 的 `editor` 字段就是它内部的 Editor（`extension-editor.js` L42），泛型查找需要能看到它。主编辑器不会被误入，因为对话框组件不持有它。
- 先测 `F` 本身，再逐层向下。

形状判断示例：

```ts
const isSelectList = (o: any) =>
  Array.isArray(o?.filteredItems) && Array.isArray(o?.items) &&
  typeof o?.selectedIndex === "number" && typeof o?.getSelectedItem === "function";

const isSettingsList = (o: any) =>
  Array.isArray(o?.items) && o.items.every((i: any) => typeof i?.id === "string" && "currentValue" in i) &&
  typeof o?.selectedIndex === "number" && typeof o?.onChange === "function";

const isFilteredList = (o: any) =>
  typeof o?.selectedIndex === "number" &&
  Object.keys(o).some((k) => k.startsWith("filtered") && Array.isArray(o[k])) &&
  (typeof o?.onSelect === "function" || typeof o?.onSelectCallback === "function" || typeof o?.handleSelect === "function");
```

#### 4.6.4 操作的统一做法：设状态 + 发按键给焦点对象

选择第 i 项：

```ts
list.selectedIndex = liveIndex;      // list 是 findShape 找到的对象；SelectList 可用 setSelectedIndex(i)
F.handleInput("\r");                 // 发给焦点对象，由宿主组件自己的逻辑完成确认
ctx.requestRender();
```

- 按键一律发给 `F`，不是发给 `list`。宿主组件会自己把按键转交给内部列表（例如 `SessionSelectorComponent.handleInput` 转给 `sessionList`，`SettingsList.handleInput` 在子菜单打开时转给 `submenuComponent`）。
- 不直接调用 `onSelectCallback(...)`，因为各组件回调参数不同。
- 搜索：先发 `ctrl+u` 清空，再逐字符 `F.handleInput(ch)`。这与终端用户的操作方式相同。注意 `SettingsList` 会去掉输入中的空格（`handleInput` 中 `data.replace(/ /g, "")`），带空格的搜索词在设置里会被合并，这是宿主行为，不做补偿。
- 执行前确认 `selectedIndex` 是数字、`liveIndex` 在范围内；不满足就返回 `false`。

#### 4.6.5 内置适配器清单（按优先级）

字段名来自 pi 0.81.1。OMP 的对应适配器基于阶段 0 的探测结果编写（`docs/host-probe/omp-18.12.5.json`）；关键结论：OMP 的扩展入口在 UI 上下文、内置选择器的焦点组件没有可读数据字段，因此 OMP 上 #5-#9 先走快照，只有入口参数（#1/#2/#3/#4/#10）能给出结构化模型。

| # | 适配器 | 识别 | 读取 / 操作 | 覆盖 |
|---|---|---|---|---|
| 1 | `ExtensionSelectAdapter` | `entry.kind === "select"`（pi：`showExtensionSelector`；OMP：UI 上下文的 `select`），或 `F` 有 `options: string[]` + `selectedIndex` + `onSelectCallback` | 标题、选项取自入口参数。`showExtensionConfirm` 的入口是 `select(title + "\n" + message, ["Yes","No"])`，识别为 `confirm`。**OMP 18.12.5**：焦点组件没有 `options`/`selectedIndex`（只有 `children` 或空），选项必须取自 UI 上下文入口参数；当前光标只能靠按键后的重渲染确认 | 扩展 `select`、`confirm` |
| 2 | `ExtensionInputAdapter` | `entry.kind === "input"`，或 `F` 有 Input 形状字段 `input` + `onSubmitCallback` | `input.setValue(text)` 后 `F.handleInput("\r")`。`secret` 只在入口明确是密钥输入时为真（pi 的 `ExtensionUIContext.input` 没有密钥标记；OMP **没有** `inputSecret`，以调用方标记为准）。**OMP 18.12.5**：焦点组件只有 `children`/`focused`，没有 `input` 字段；输入文本只能通过 `F.handleInput` 逐字发送 | 扩展 `input` |
| 3 | `ExtensionEditorAdapter` | `entry.kind === "editor"` | 内部编辑器（字段 `editor`）`setText(text)` 后发 Enter 给 `F`。已核对：Enter 提交，Shift+Enter 换行（`extension-editor.js` L46-49）。**OMP 18.12.5**：焦点组件只有 `children`/`focused`，内部编辑器不可达；用 `F.handleInput` 输入 + Enter | 扩展 `editor` |
| 4 | `AskDialogAdapter`（OMP） | `entry.kind === "ask"`（工具 UI 上下文的 `askDialog`） | 输出 `questionnaire` 模型：问题和选项取自 `askDialog(questions, options)` 的**第一个参数**（问题数组，每项 `id/question/header/options/recommended`），第二参数是 `{timeout, signal, acceptImages}`。**OMP 18.12.5 的焦点组件只有 `callbacks`/`options`，当前 tab、光标、已答状态都在闭包里**：适配器必须自己维护 `active`/`answers`，每次操作后重渲染确认；切换问题/选项全部发按键（探测的图例为 `Tab/←→` 切题、`↑↓` 选择、Enter 确认、Esc 取消） | OMP `ask` 工具 |
| 5 | `SettingsListAdapter` | `F` 是 SettingsList 形状（`/settings` 的焦点就是 `getSettingsList()`） | 主列表读 `items`/`filteredItems`、`selectedIndex`。**子菜单**：`activateItem` 打开子菜单时只设置私有字段 `submenuComponent`，不调用 `setFocus`，后续按键由同一个 SettingsList 转交（pi-tui `settings-list.js` 的 `handleInput`/`activateItem`）。所以子菜单是**同一会话内的嵌套状态**：`read()` 发现 `submenuComponent` 非空时，对它用 `findShape` 找 SelectList 并生成 `submenu.model`；对子菜单的操作仍发给 `F`。设置 `submenuComponent` 内 SelectList 的 `selectedIndex` 后发 `\r` 给 `F`。子菜单形状不是 SelectList 的（例如 `settings-selector.js` 中的 `ThemeSubmenu`，有自己的模式状态）→ 子菜单部分降级为快照，只提供 ↑↓/Enter/Esc。**cycle**：先确认目标值在 `item.values` 中，且 `item.currentValue` 也在其中（否则返回 `false`，例如当前值是显示用的标签而不在 `values` 里）；按 `(indexOf(目标) − indexOf(当前) + n) % n` 算出按键次数，选中该项后发对应次数的 `\r`；最后重读确认 `currentValue` 已变。**OMP 18.12.5**：`showSettingsSelector` 的焦点组件（`AU`）没有任何自有字段，主列表/子菜单数据不可读 → 整个适配器降级为快照 | `/settings` |
| 6 | `SelectListAdapter` | `findShape(F, isSelectList)` 命中 | `filteredItems` 的 `value/label/description`；操作见 §4.6.4。**OMP 18.12.5**：内置选择器（model/session/tree/oauth）的焦点组件没有 `items`/`filtered*`/`selectedIndex`，此适配器在 OMP 上不会命中，交给 #13 | theme、thinking、show-images 等选择器（pi） |
| 7 | `FilteredListAdapter`（通用） | `findShape(F, isFilteredList)` 命中 | 标签提取器依次尝试 `label ?? name ?? title ?? id ?? String(x)`；当前值比较组件上的 `current*` 字段。**OMP 18.12.5**：内置 model/session 选择器的数据在闭包里，`findShape` 不命中 → 快照 | model（`filteredModels`、`currentModel`）、oauth（`filteredProviders`）、session（`sessionList.filteredSessions`）、scoped-models、tree、fork 的消息列表（pi） |
| 8 | 专用适配器 | 按需 | — | pi：`ModelSelectorAdapter`（`provider/id`，标当前模型，作用域切换键）、`SessionSelectorAdapter`（会话名或首条消息、时间；删除、排序、名称筛选等按键作为 `extraActions`）。OMP 18.12.5：model/session/tree/oauth 的焦点组件没有可用字段，阶段 3 只能先按快照提供按键；不新增 OMP 专用字段适配器，除非后续版本暴露字段 |
| 9 | `LoginDialogAdapter` | `F` 或 `root` 是登录对话框形状（有 `abortController`/`signal` + Input + 登录相关入口：`showLoginDialog`、`showApiKeyLoginDialog`） | 输入一律 `secret: true`。`LoginDialogComponent` 提交后会把输入框替换成文本 `> value`（`login-dialog.js` 的 `replaceInputWithSubmittedText`），所以**此适配器禁止对该对话框截图**，info 文本必须先脱敏。**OMP 18.12.5**：`/login` 先走 `showOAuthSelector`（焦点 `CF`，只有 `children`），没有发现 API key 对话框；OMP 的登录列表阶段 3 先按快照处理 | `/login` 的 API key、授权码输入（pi） |
| 10 | `ApprovalAdapter`（OMP） | `entry.kind === "approval"`（工具 UI 上下文的 `approve`） | 入口参数是 `{full, compact, session}` 三个字符串；焦点组件只有 `callbacks{onApprove,onDeny}` / `options{fullPrompt, timeout, session, draft}`。模型标题/详情取 `full`，选项由组件自己渲染的按键决定（探测到 `handleInput`）；操作发按键给 `F`，不直接调用 `callbacks` | OMP `approve` |
| 11 | `CustomGoalAdapter` | 见 §4.6.6：pi-goal 0.6.x 的三种形态都只有 `render/invalidate/handleInput`，没有字段，按例外规则识别 | 单问 → `select`；确认框 → `confirm`；多问 → `questionnaire`。通过 `F.handleInput` 发按键完成，不再旁路 `done` | pi-goal 0.6.x |
| 12 | `InfoPanelAdapter` | **只在有正面证据时命中**：pi 按已知构造器/字段白名单；OMP 18.12.5 按入口语义白名单（`showCommandReport`、`showDebugSelector`、`showUsageDashboard`、`showExtensionsDashboard`、`showAgentsDashboard`）登记，焦点组件只有 `children`/空字段 | `render(80)` 去色、脱敏后作为只读文本，按钮只有"关闭"（发 Esc） | 已确认的只读面板（pi + OMP 入口白名单） |
| 13 | `UnsupportedAdapter`（v6，取代 `SnapshotAdapter`） | 永远为真 | 不读画面；只取组件类型名和入口标题（如有） | 未知组件。Telegram 只显示"终端上有一个 Telegram 无法处理的对话框（<类型>），请在终端处理"，按钮只有"取消"（发 Esc）（§0.1 第 3 条） |

每个适配器都要有单元测试（§7.1）。

#### 4.6.6 不透明组件：原则 2 的例外（仅限本节两种）

背景：扩展通过 `ctx.ui.custom(factory)` 提供的组件是不透明的，宿主不知道它的结构。现有 `custom-dialogs.ts` 识别 pi-goal 对话框的方式是"渲染成文本 → 正则匹配"（`detectShape`、`extractConfirmationHeader`、`parseTabBarIds` 等），这违反原则 2。

处理顺序：

1. **先结构化。** 阶段 0 必须探测 pi-goal 的三种 custom 组件（确认框、`goal_question` 单问、`goal_questionnaire` 多问），记录 `constructor.name` 和自有字段。只要能找到问题、选项、答题状态的字段，就写结构化适配器，不使用例外。
2. **证明没有可用字段时，才启用例外**，并且必须同时满足：
   - 只适用于 `custom()` 生成的组件，并且是 `CustomGoalAdapter` 白名单中登记过的已知形态（目前只有 pi-goal 的三种）；其他扩展的 custom 组件一律走快照；
   - 渲染文本只能用于**识别形态和读取选项文字**；
   - 所有操作都通过 `F.handleInput` 发按键完成（例如选项序号对应的方向键次数 + Enter，或组件自己的 Tab 切题），**不得**像现有代码那样绕过组件直接调用 `done` 构造结果；
   - 发按键前重新渲染、重新识别，确认目标选项仍在原位置，不一致就重绘 Telegram 消息并提示"列表已变化"；
   - 适配器绑定已测试的 pi-goal 版本范围（写在适配器常量里），版本不在范围内或识别失败时按 §0.1 第 3 条明确告知，不退回快照；
   - 契约测试使用该版本的 pi-goal 真实组件，pi-goal 升级导致文本变化时测试先失败。
3. 例外启用与否、依据的探测文件，记录在本节末尾（阶段 0 完成后填写）。

阶段 0 结论（2026-10-23，pi-goal 0.6.0）：确认框、`goal_question` 单问、`goal_questionnaire` 多问都由 `ctx.ui.custom` 返回**同一个 Object 形态**，自有字段只有 `render`、`invalidate`、`handleInput`；问题、选项、当前 tab、已答状态全部在工厂闭包里，探测没有找到任何可读的结构化字段。三种形态的 `render(80)` 已记录在 `docs/host-probe/pi-0.81.1.json` 的 `conclusions.piGoal`。

因此**启用例外一（pi-goal）**，条件收窄为：

- 白名单只包含 pi-goal `0.6.x` 的这三种形态；确认框按标题 `Confirm Goal Draft` / `Confirm Sisyphus Goal Draft` 识别（单问/多问没有这个标题），单问与多问按渲染文本中的题目数量和 tab 栏区分。
- 渲染文本只用于识别形态和读取标题/选项文字；当前光标、已答状态、当前 tab 由 `CustomGoalAdapter` 自己维护，并在每次操作后重新 `render` 确认目标仍在原位置。
- 操作全部通过 `F.handleInput` 发按键（↑↓ 选择、Enter 确认、Tab/←→ 切题、Esc 取消），**不调用 `done`**。
- 版本不在 `0.6.x`、渲染里找不到预期标题/选项、或重渲染结果与模型不一致 → 交给 `UnsupportedAdapter` 明确告知（§0.1 第 3 条）。
- 契约测试固定使用 pi-goal 0.6.0 的真实组件；升级导致文本变化时测试先失败。

**例外二：OMP 入口对话框的当前行定位（2026-10-24 启用；已被 §4.11 取代，过渡期保留，T3.2g 删除）**

背景：OMP 18.12.5 的扩展 `select`/`input`/`editor` 与 `askDialog` 组件把行和光标放在私有字段里，类名被压缩，无法按字段读取（§9 决定 28、35、36）。

使用条件（全部满足才使用，否则退回 `SnapshotAdapter`）：

- 只用于有入口记录（`EntryInfo`）的 OMP 对话框。题目、标题、选项文字**一律取自入口参数**。
- 渲染帧（`render(80)` 去色）只用于两件事：确定当前高亮行、确定屏幕上可见的行。**不得**从帧里读取选项文字或任何状态值（下面 `approve` 的按键说明除外）。
- 操作全部通过 `F.handleInput` 发按键。按键前重新渲染，确认目标行仍在可见行里，步数按可见行计算；对不上就拒绝操作并重绘 Telegram 消息。
- 绑定 OMP 版本范围 `18.12.x`（写在适配器常量里）；版本不在范围内或无法确定版本时退回快照。
- 契约测试固定使用 OMP 18.12.5 的真实帧（`docs/host-probe/omp-18.12.5.json` 的 `conclusions.dialogFrames`）；OMP 升级导致帧格式变化时测试先失败。
- 唯一允许从帧里读取的文字：OMP `approve` 对话框页脚的按键说明（§4.6.5 #10），用来确定有哪些可按的选项；同样受上面的版本限制。
- **不得**用于 OMP 内置选择器（`/model`、`/settings`、`/resume`、`/tree`、`/login` 等 `show*Selector` 打开的组件），它们仍按 §9 决定 18 走快照。插件自己通过 `ui.select` 弹出的列表（例如 OMP 上 Telegram 的 `/model`，由 `lib/commands/model.ts` 处理）属于入口对话框，适用本例外。

### 4.7 TelegramDialogRenderer

#### 4.7.1 回调数据格式

Telegram 回调数据上限 64 字节。**所有对话框（包括快照）统一用新前缀**：

```
tgplus:dlg:<sessionId>:<generation>:<op>[:<arg>]
```

- `sessionId`、`generation` 用 base36。
- `op`：`c`（choose）、`t`（toggle）、`v`（cycle，arg = 值序号）、`m`（submenu）、`q`（切换问题，arg = 问题序号）、`p`（翻页，arg = 页码）、`s`（搜索输入）、`y`/`n`（confirm）、`a`（approval，arg = 选项序号）、`i`（文字输入）、`k`（按键，arg = 键名）、`x`（取消）。
- choose/toggle 的 arg 是**页内序号**，服务端用 `session.keyMap[generation]` 映射回 `item.key`，因此回调长度与 key 长度无关。
- 在 `lib/callback-protocol.ts` 新增 `encodeDialogCallback` / `decodeDialogCallback`，并有单测断言所有组合不超过 64 字节。
- 旧前缀 `tgplus:tui:` 在过渡期仍由旧镜像代码处理；阶段 5 删除镜像后，收到旧前缀一律回复"该按钮已过期"。原因：旧回调没有会话标识，进程重启或对话框更换后会作用到错误的组件。

#### 4.7.2 各类型布局

| kind | 正文 | 键盘 |
|---|---|---|
| select | `<b>标题</b>`，搜索中附 `🔍 词`，`第 x/y 页 · 共 n 项` | 每项一行：`▸`（读取时的终端光标）+ `✓`（当前值）+ 标签（截断 45 字符）；每页 10 项；`◀ 上一页` `下一页 ▶`；`🔍 搜索` `取消`；`extraActions` 每行最多 3 个 |
| select（multi） | 同上 | 每项前加 `☑/☐`，底部 `⏎ 提交` |
| settings | `<b>标题</b>`，每项"标签：当前值" | 每项一个按钮；2 个取值的直接切换；多于 2 个的展开为值列表（原地编辑，带"返回"）；有子菜单的进入子菜单视图（显示 `submenu.model`，带"返回"，"返回"发 Esc） |
| questionnaire | 标题 + 当前问题 + 各题完成状态（`✓`/`·`） | 问题切换行 `◀ 上一题` `下一题 ▶`；当前问题的选项（单选/多选同 select）；`allowCustom` 时 `✏️ 自己输入`；`canSubmit` 时 `⏎ 提交全部`；`取消` |
| approval | 标题 + 详情 | 每个选项一个按钮 |
| confirm | 标题 + 消息 | `✅ 是` `❌ 否` |
| input / editor | 标题 + placeholder/prefill（`<pre>`），提示"直接发送一条消息作为输入" | `取消` |
| progress | `⏳ 文本` | `取消`（`cancellable` 时） |
| info | 文本 | `关闭` |
| snapshot | 截图（`<pre>`）+ "未适配的对话框" | `↑` `↓` `Enter` `Esc` `⌨️ 输入` |

#### 4.7.3 消息生命周期

- **命令 scope** 内的连续对话框和 progress 原地编辑同一条消息（例如 `/login` 的多步）；输出（OutputCapture）作为后续新消息。
- 会话关闭后，消息改为摘要并移除键盘。
- **turn** 内的对话框：每个对话框新发一条消息，回复到触发该 turn 的用户消息（`TelegramTurn.sourceMessageId`）。
- `▸` 只表示读取时的光标位置，不随终端操作更新。

#### 4.7.4 密钥处理

- 来源：`LoginDialogAdapter`（固定 `secret: true`）；宿主入口明确标记为密钥的输入（包括 Telegram turn 中通过 UI 上下文 `inputSecret` 发起的输入，若宿主提供该方法）。不用标题关键词猜测。
- 用户回复后立即删除该消息；日志中不记录内容。
- 原文存入**按 chat + thread 的密钥表** `SecretStore`（这样 Telegram turn 中输入的密钥也能覆盖）。每条记录保留 24 小时；该 chat 执行 `/new` 时清空其记录；进程退出即丢弃，不落盘。
- **长度不到 8 个字符的密钥不登记**，不参与替换。短串（例如 `b`）全局替换会误伤正常文字。API key、授权码都远长于这个长度。
- **在源头替换，不在传输层替换。** 传输层收到的是已经转义、转换过的 HTML 和单独的 `richMarkdown`：密钥中含 `& < > "` 时 HTML 里已变成实体，精确匹配不命中；在 HTML 上替换还可能改坏标签。所以替换必须发生在**转成 HTML 之前的原始文本**上，由每个发送源各自调用 `SecretStore.redact(chatKey, text)`：
  - OutputCapture：截获到的原始字符串，在转换为 HTML/Markdown 之前；
  - Broker：摘要、info 文本、快照文本，在渲染之前；
  - `lib/renderer.ts`：assistant 文本、思考、工具参数和输出，在 Markdown → HTML 转换之前（同时作用于 `richMarkdown` 的原始 markdown）。
  - 传输层**不做**替换。
- 摘要只写"✅ 已提交（内容已隐藏）"。
- 局限（写进 README）：
  - 只能替换与输入**完全相同**的字符串；agent 对密钥做了变形（截断、编码）再输出时无法识别；
  - 密钥一旦进入会话历史（例如 agent 把它写进了回答），24 小时或 `/new` 之后再被带出时不会被替换；
  - 不经过上述三个发送源的路径（例如将来新增的发送代码）需要自行调用 `redact`。
- 这是固定行为，不提供配置开关。

### 4.8 终端专属命令映射

在 Gateway 优先级第 2 步执行。

| 命令 | 宿主行为 | Telegram 等价 |
|---|---|---|
| `/copy` | 复制最后一条回复到剪贴板 | 不提交。读取会话中最后一条 assistant 文本，直接作为消息发送 |
| `/export [path]` | 导出到文件，`showStatus("Session exported to: <path>")` | 提交给宿主。包装 `session.exportToHtml` / `exportToJsonl`，取**返回值**作为文件路径，命令结束后把文件作为文档发送到 Telegram（复用现有附件发送）。不从输出文本里解析路径。包装是常驻的实例 hook，但**只在当前命令 scope 的标签是 `/export` 时记录返回值**：`/share` 内部也会调用 `exportToHtml(tmpFile)`，那个临时文件不能被当成导出结果发出去 |
| `/share` | 上传 gist，输出 URL | 直接提交，输出由 OutputCapture 回传 |
| `/hotkeys` | 显示终端快捷键 | 不提交。发送插件生成的 Telegram 用法说明 |
| `/quit`、`/exit` | 退出进程 | Telegram 上二次确认（`✅ 确认退出` / `取消`），确认后提交 |
| `/debug` | 写调试文件 | 直接提交，输出回传 |
| `/import` | 从文件导入 | **保留原生处理器**，不提交编辑器（§9 决定 21）；参数照传 |
| `/reload` | 重新加载扩展/技能/提示词 | **保留原生处理器**（§9 决定 21） |
| `/fork`、`/clone` | 复制会话/分支 | **保留原生处理器**（§9 决定 21）；需要选择器的步骤由阶段 3 的 Broker 接管 |
| `/new` | 清空当前会话 | **调用宿主 `ctx.newSession()`**，不提交编辑器（§9 决定 22）；完成后通知并恢复草稿 |
| 外部编辑器（`ctrl+g`） | 打开 `$EDITOR` | 不支持；editor 对话框只能用"发送一条消息"输入 |
| 彩蛋命令（`/arminsayshi`、`/dementedelves`） | 动画 | 直接提交，输出回传 |

OMP 的同类命令按同样原则补表：默认"直接提交 + 输出回传"，只有需要确认或终端绑定的才进表。阶段 0 探测到的 OMP 18.12.5 内置注册表共 **87** 个命令（`BUILTIN_SLASH_COMMAND_DEFS`，完整名单见 `docs/host-probe/omp-18.12.5.json` 的 `catalog`）。按行为分类：

| OMP 命令 | 宿主行为（阶段 0 探测） | Telegram 等价 |
|---|---|---|
| `/help`、`/status`、`/usage`、`/stats`、`/context`、`/changelog`、`/debug`、`/skills`、`/plugins`、`/extensions`、`/tools`、`/agents`、`/mcp`、`/plan`、`/session`、`/jobs`、`/todo`、`/memory` | 输出信息或打开只读面板（`showCommandReport`/`showDebugSelector`/`showUsageDashboard`/`showExtensionsDashboard`/`showAgentsDashboard`） | **阶段 3 接入 Gateway**：先实现 `InfoPanelAdapter`/快照面板截获，正文回传；按钮只有"关闭"。阶段 1 不接入，否则只会回 ack（§9 决定 23） |
| `/model`、`/models`、`/switch`、`/modelpreset`、`/effort`、`/settings`、`/theme`、`/thinking`、`/sessions`、`/resume`、`/pin`、`/tree`、`/fork`、`/login`、`/logout` | 打开选择器（`showModelSelector`/`showSettingsSelector`/`showSessionSelector`/`showTreeSelector`/`showOAuthSelector`）；探测确认这些焦点组件没有可读数据字段 | 直接提交；阶段 3 先按 `SnapshotAdapter` 提供 ↑↓/Enter/Esc，不伪装成原生列表（§4.6.5 OMP 结论） |
| `/new`、`/fresh`、`/clear`、`/delete`、`/fork`（确认）、`/cleanse`、`/wt`、`/worktree` | 可能弹确认框或要求参数 | 直接提交；确认框按 §4.7.2 的 `confirm` 渲染，按钮"是/否" |
| `/copy`、`/open` | 读最后一条消息/链接；`/copy` 可能打开 `showCopySelector` | `/copy` 不提交，直接把最后一条 assistant 文本发到 Telegram；`/open` 直接提交，输出回传 |
| `/export` | 调用 `session.exportToHtml(path, false)`，返回 Promise | 提交；等 Promise 解析，把解析出的文件作为文档发送（探测文件的 `export-resolved`；不解析状态文本） |
| `/share`、`/collab`、`/join`、`/leave`、`/hub` | 网络/分享流程；可能有进度条 | 直接提交，输出回传；进度条按 `progress` 模型 |
| `/quit`、`/exit`、`/restart`、`/reload-plugins`、`/marketplace`、`/ssh`、`/browser`、`/record`、`/live`、`/pause`、`/force` | 终端/进程绑定或高风险 | `/quit`、`/exit`、`/restart` 二次确认后提交；其余直接提交，参数照传 |
| 其余命令（`/goal`、`/guided-goal`、`/loop`、`/queue`、`/prewalk`、`/advisor`、`/ratchet`、`/computer`、`/skillful`、`/extended-context`、`/fast`、`/slow`、`/shake`、`/handoff`、`/seance`、`/btw`、`/tan`、`/omfg`、`/retry`、`/rename`、`/move`、`/add-dir`、`/remove-dir`、`/dirs`、`/git`、`/branch`、`/forget-approvals`、`/dump`、`/trace`、`/security`、`/setup`） | 多为状态切换/输出/参数命令 | 默认直接提交 + 输出回传；有对话框的按入口 kind 走 Broker |

OMP 的 `showAskDialog` 和 `approve` 不是命令，分别来自 `ask` 工具和工具审批；它们的模型见 §4.6.5 #4/#10。

### 4.9 Agent turn 中的对话框

现状：Telegram turn 期间，`ExtensionUIContext` 被替换为 Telegram 原生 UI（off/commands 模式），或者 `createPromptObserverUi`（full 模式）。

改为（`on` 模式，桥接可用时）：

1. Telegram turn 期间（以及 Gateway 提交的命令期间，§4.2.6）的 `select/confirm/input/editor/custom/askDialog/approve` **全部委托给宿主 UI**，由宿主在终端绘制。Broker 通过焦点 hook 接管，按 §4.3 推送。`createPromptObserverUi` 改名为 `createHostPromptUi`，简化为：
   - 提示类方法直接转给宿主，不再触发 `startPromptMirror`；
   - **`notify` 只转给宿主，不再同时调用 `telegramUi.notify`。** 宿主会把 `notify` 转成 `showStatus`/`showError`/`showWarning`（`showExtensionNotify` L1891），由 OutputCapture 按归属发到 Telegram。这样只有一条发送路径，不会双发。（`off` 模式的 `createRoutedTelegramUi` 不受影响。）
   - 编辑器类方法（`pasteToEditor`、`setEditorText`、`getEditorText`）在 Telegram turn 期间不做任何事（继承旧文档原则 3）。
2. 删除 `startPromptMirror` 和 `promptMirrorHook`；`runWithTelegramUi` 的参数改为 `uiMode`（§4.2.6）。
3. `custom()`：宿主生成组件并给它焦点，Broker 照常接管；认不出来按 §0.1 第 3 条明确告知。不再直接返回 `undefined`。
4. （v6 删除：桥接不可用时插件启动报错，不再有 `off` 模式，§0.1。）
5. **删除本地命令镜像。** 现有的 `bridge.onLocalSubmit` 订阅（控制器中 `unsubscribeLocalTui` 一段）会把本地用户在终端敲的 `/` 和 `!` 命令及其结果截图推送到活动 chat，这违反"谁发起，谁显示"（§9 决定 1）。`on` 模式下不再注册该订阅；`off` 模式本来就不推送（该订阅在 `off` 下直接返回）。相应删除 README 和 E2E 中"local-command mirror"的说法与用例。

### 4.10 配置

`tuiBridge` 的取值：

| 值 | 含义 |
|---|---|
| `on`（默认） | 本方案的架构 |
| `off` | **v6 删除**（§0.1 第 4 条）：`tuiBridge` 配置项整体删除，读到旧配置时忽略并在日志里提示一次 |

旧值迁移：未设置、`commands`、`full` → `on`。迁移写在 `lib/config.ts` 的读取逻辑里，不改写配置文件，直到用户下次在 `/tg → Config` 中保存。

**这是有意的行为变更**：没有改过配置的用户（原缺省 `commands`，交互对话框只读）升级后会直接获得可操作的对话框和"谁发起谁显示"的共享行为。必须在 `CHANGELOG.md` 中以"行为变更"单列说明，并在 README 中更新对应段落。

不新增其他配置项。

`/tg → Config` 菜单（`lib/commands/tg-menu.ts`、`lib/commands/tg-config.ts` 中读取 `config.tuiBridge` 的地方）只保留 `on`/`off`。

**v6：删除 `off` 模式和 `tuiBridge` 配置项**（任务 D1），`/tg → Config` 菜单中的对应选项一并删除。

---

### 4.11 OMP 结构化通道（v5，2026-10-24）

依据：OMP 18.12.5 源码（MIT，本机只读副本 `/Users/jaly/Documents/project/research/oh-my-pi-18.12.5`）和 2026-10-24 的三次可行性验证（S20 读结构、S21c 结构化操作、S22 collab 请求）。OMP 自带两套结构化接口：**collab**（远程访客回答对话框）和 **TSP**（组件把自己描述成语义树，并接收结构化事件）。OMP 上的对话框一律走这两条通道或输出截获，**不再读画面、不再模拟按键**。pi 一侧不受影响。

#### 4.11.1 通道分配

| OMP 对话框 | 通道 | 读取 | 操作 |
|---|---|---|---|
| 扩展 `select`、`confirm`、`input`、`editor`、`askDialog`、`approve` | 扩展 UI 竞答（§4.12，v7 取代 collab） | 调用参数 | 先回答的一方生效，另一方被关闭 |
| 扩展 `custom`；内置选择器与仪表盘（`/model`、`/settings`、`/login`、`/resume`、`/tree`、`/agents` 等） | TSP | 焦点组件或其子组件的 `describe(cx)` 语义树 | `handleNativeEvent(event)`：`select`、`activate`、`action`（`confirm`、`close`、`submit`、`cancel` 等）、`change`、`edit` |
| 报告（`showCommandReport`） | 输出截获（§4.4，S17/S19） | 入口参数 `title` + `body` 渲染 | — |
| 没有 `describe()` 的组件 | `UnsupportedAdapter`：明确告知 + 取消（决定 47） | — | 取消 = Esc |

#### 4.11.2 collab 桥接（v7 作废）

由 §4.12 扩展 UI 竞答取代（决定 53）。S22 证明 collab 可用，但竞答不占用 `mode.collabHost`，用户自己开 `/collab` 时不需要让位，并且 pi 与 OMP 共用一套做法。

#### 4.11.3 TSP 适配器（`TspAdapter`）

- **识别**：焦点组件或其子组件（`children`，深度 ≤ 4）同时有 `describe` 和 `handleNativeEvent` 方法 → `TspAdapter`，在 OMP 上优先于其他适配器。
- **上下文**：`cx = { cols: 80, reduceMotion: true, dark: true, hour12: false, supports: () => true, feature: () => false }`（启用 picker 形式）。
- **读取**：语义树转换为 `DialogModel`：`picker` → select（项、选中项、可用动作）；`prefs` → settings；卡片 + 列表 → select；表单/输入框 → input；其余 → info（只读文本 + 关闭）。遍历要防循环引用；子节点里不是 `NativeNode` 的对象忽略。
- **操作**：按钮动作转换为 `NativeUiEvent`（例：选项 → `{ type: "select", key: "picker", item }`，确认 → `{ type: "action", key: "picker", act: "confirm", mods: [] }`，关闭 → `act: "close"`）。文本输入在 T3.2f 验证 `edit` 事件之前，沿用现有输入路径（写入值后提交）。
- **刷新**：每次操作后重新 `describe()`；终端侧的变化由焦点事件和重绘触发重读。
- **版本**：见 §4.11.4。

#### 4.11.4 版本约束：不符即失败，不做降级

- collab 与 TSP 都是 OMP 内部接口，结构化通道只支持 OMP `18.12.x`（版本取自 `@oh-my-pi/pi-utils` 的 `VERSION`）。
- **版本不符或读不到版本：直接失败，不退回任何其他做法**（不读画面、不走镜像、不模拟按键）。插件启动时在状态栏和 Telegram 明确提示"不支持的 OMP 版本 <x>，需要 18.12.x"，OMP 的对话框不桥接到 Telegram（用户 2026-10-24 确定："版本不对直接失败，不要搞多套"）。
- 支持新版本的方式：拉取对应 tag 的 OMP 源码核对接口，跑通 dialogs 与 commands 套件后再放宽版本范围。

#### 4.11.5 被取代的内容

- §4.6.6 例外二：OMP 的 select、confirm、approve 改走 collab/TSP 之后删除相应代码（`OMP_FRAME_VERSIONS`、OMP 路径上的 `frameRows`/`frameCursor`、approve 读按键说明）。过渡期保留，T3.2g 删除。
- 决定 18 作废；决定 25、28、35、36 中关于 OMP 按焦点/按画面识别与操作的部分被取代。决定 30、40（progress 与 loader 的区分）不受影响。
- broker 保留为会话和 Telegram 渲染的唯一中枢；会话来源从"焦点变化"扩展为"焦点变化 + 竞答请求"（§4.12）。OMP 上的适配器只剩：竞答模型、`TspAdapter`、`infoPanelAdapter`（无 `describe()` 的仪表盘）和 `UnsupportedAdapter`。

### 4.12 扩展 UI 竞答（v7，2026-10-25，pi 与 OMP 共用）

依据：S25（OMP，pi）与 S25b（pi）实测，以及 pi 1.4.0 `core/extensions/types.ts` 的 `ExtensionUIDialogOptions.signal`（"AbortSignal to programmatically dismiss the dialog"）。宿主收到 abort 后关闭自己的对话框，原调用以 `undefined` 结束。

- **支持竞答的方法**：pi 1.4.0 为 `select`、`confirm`、`input`（`editor` 不接受 `opts`）；OMP 18.12.x 为 `select`、`confirm`、`input`、`editor`、`askDialog`、`approve`。不接受 signal 的方法（pi 的 `editor`、两个宿主的 `custom`）不竞答，按现有适配器处理（`custom` 按 §4.6.5 明确告知，pi-goal 走例外一）。
- **拦截位置**：扩展实际拿到的 UI 上下文对象（`extensionRunner.getUIContext()`，FocusTracker 的 `attachEntryHooks` 已经在这里挂钩入口）。
- **归属**：沿用 broker 的归属规则（§4.3）：只有 Telegram 发起的命令作用域或 Telegram turn 里的对话框才发到 Telegram（谁发起谁显示，决定 42 保留）。
- **流程**：
  1. 用调用方的 signal 加上插件自己的 `AbortController`（`AbortSignal.any`）调用宿主方法，终端照常画出对话框；
  2. 宿主照常画出对话框，broker 照常经焦点变化建会话（一个对话框只有一个会话）；模型取自入口参数（标题、选项、提示文字）；
  3. Telegram 先回答 → 适配器不再模拟按键，而是经竞答句柄把值直接交给调用方，再 abort 宿主（宿主返回的 `undefined` 丢弃）；
  4. 终端先回答 → 以宿主的值 resolve，broker 照常撤掉 Telegram 键盘并写摘要；
  5. 调用方的 signal 先中止 → 宿主关闭对话框，调用以宿主的结果结束；
  6. 竞答句柄挂在入口记录上（`EntryInfo.race`），由最外层的竞答包装在调用宿主方法之前登记；本地发起的对话框也有句柄，但只有 Telegram 的按钮会用它，所以不改变终端行为。
- **实测结论**：两个宿主上，插件的答案都送达了扩展，宿主对话框在 abort 后约 2ms 关闭，后续 input、secret、custom、ask 步骤照常通过。S25 里 pi 的 confirm 步骤失败，S25b 查明是测试脚本的问题：`clearDialog()` 在约 400ms 内连发两次 Escape，pi 编辑器为空时这会触发双击 Escape 动作（`doubleEscapeAction`，默认 `tree`，pi 1.4.0 `interactive-mode.ts` 第 3036–3050 行），打开 Session Tree；之后发来的命令被插件按设计拒绝（"终端上有一个未完成的对话框"）。不加竞答的基线运行也打开了 6 次 Session Tree，只是时机没有挡住后续步骤。3B 第一项任务修测试脚本：在测试用的 agent 设置里写 `doubleEscapeAction: "none"`。

## 5. 文件改动清单

### 新增

| 文件 | 内容 |
|---|---|
| `lib/tui/host.ts` | `wrapMethod`、mode 捕获（从 `tui-bridge.ts` 迁移）、`HostCapabilities`、实例 hook 的重新安装 |
| `lib/tui/focus.ts` | FocusTracker、焦点分类、焦点校验定时器、编辑器本地输入标记 |
| `lib/tui/origin.ts` | OriginTracker、CommandScope |
| `lib/tui/gateway.ts` | 分发优先级、提交、草稿保护、终端专属映射、`runAsTelegramCommand` |
| `lib/tui/output.ts` | OutputCapture、脱敏 |
| `lib/tui/broker.ts` | DialogBroker、外部文本输入注册 |
| `lib/tui/model.ts` | 类型 |
| `lib/tui/find-shape.ts` | `findShape` 和形状判断 |
| `lib/tui/adapters/*.ts` | §4.6.5 各适配器，`index.ts` 定义注册顺序 |
| `lib/tui/render-telegram.ts` | Renderer |
| `lib/tui/snapshot.ts` | 快照兜底 |
| `lib/tui/probe.ts` | 阶段 0 探测 |
| `lib/__tests__/tui-*.test.ts` | §7 |

### 修改

| 文件 | 改动 |
|---|---|
| `lib/controller.ts` | 抽出 `holdThroughEnqueuedTurns`（§4.2.6）；`runWithTelegramUi` 的 `observePrompts` 参数改为 `uiMode`，`createPromptObserverUi` 改名 `createHostPromptUi` 并按 §4.9 修改（`notify` 只转宿主）；`on` 模式不再注册 `bridge.onLocalSubmit` 订阅（§4.9 第 5 条）；导出 `getTopTelegramTurn`；`dispatchNamedCommand` 改为 §4.2.2；消息处理在 `resolveInput` 前加 §4.5.1 的分类；回调分发加 `tgplus:dlg:`；阶段 5 删除镜像代码（`TuiMirror`、`refreshTuiMirror`、`startPromptMirror`、`promptMirrorHook`、`runTuiCommand`、`runTuiCommandInner`、`buildSelectorKeyboard`、`formatSelectorMessage`、`tuiKeyRows`、`advertisedKeys`、`formatTuiSnapshot`、`trimScreenChrome`、`snapshotLinks`、`hasInputPrompt`、`handleTuiCallback`，以及三个命令集合常量） |
| `lib/telegram-ui.ts` | 新增 `registerExternalInput`（§4.5.1） |
| `lib/renderer.ts` | 转换前调用 `SecretStore.redact`（§4.7.4） |
| `lib/tui/secrets.ts`（新增） | `SecretStore`：登记、按 chat 清空、`redact` |
| `lib/tui-bridge.ts` | 阶段 1 起内容迁移到 `lib/tui/host.ts`、`lib/tui/snapshot.ts`，本文件只保留重新导出，供未迁移的调用方使用；**阶段 5 删除** |
| `lib/callback-protocol.ts` | dialog 回调编解码 |
| `lib/config.ts`、`lib/types.ts` | §4.10 |
| `lib/commands/tg-menu.ts`、`tg-config.ts` | 配置菜单 |
| `index.ts` | 初始化顺序：`installTuiBridge` → mode 捕获后安装 focus/output/submit hook → Broker 启动 |
| `README.md`、`CHANGELOG.md` | 新行为与行为变更说明；改写 "Interactive modals are Telegram-only during a Telegram turn" 段落和 "Mirrored dialogs arrive as one Telegram message" 段落 |
| `docs/telegram-interactions-plan.md` | 顶部注明原则 1 已被本文取代，原则 2-4 仍有效 |

### 删除（阶段 5）

- `lib/tui-selector.ts` 和 `lib/__tests__/tui-selector.test.ts`
- `lib/tui-bridge.ts`

---

## 6. 分阶段实施

每个阶段可单独合并，保持 `npm run typecheck`、`npm test` 通过。

### 阶段 0：宿主探测（实现前必做）

目的：取得 OMP 的真实方法名、参数形状和组件字段，替代"在二进制里搜到了字符串"这种未经验证的结论；同时复核 pi 的焦点对象。

- `lib/tui/probe.ts`：环境变量 `PITG_PROBE=<输出文件>` 打开时：
  - 记录 `InteractiveMode.prototype` 的全部方法名、mode 实例和 `mode.ui` 实例的自有字段名；
  - 包装 §4.1.2 表中所有入口方法，记录每次调用的参数（对象只记录字段名和基本类型值，不记录大对象）；
  - 包装 `ui.setFocus` 和 `showOverlay`，每次记录焦点对象的 `constructor.name`、自有字段名，以及 `findShape` 的命中结果。
- 用现有的 tmux + mock E2E 环境（`scripts/e2e/`）在 OMP 和 pi 上依次执行全部命令，以及触发一次 `ask`、一次扩展 `select/input`、一次 `approve`。
- 安装 pi-goal（`@capyup/pi-goal`），用 mock provider 依次触发确认框、`goal_question`、`goal_questionnaire`，记录这三种 custom 组件的字段，据此填写 §4.6.6 的结论。
- 额外记录：OMP 的默认编辑器字段名、当前焦点的读法、主循环相关字段（对应 pi 的 `pendingUserInputs`、`onInputCallback`）、聊天区中 agent 渲染组件的构造器名和字段。
- 产出 `docs/host-probe/omp-18.12.5.json`、`docs/host-probe/pi-0.81.1.json`，并据此修订 §4.1.2、§4.6.5 的 OMP 部分和 §4.8 的 OMP 命令表。
- **验收**：两份探测文件已提交；本文 OMP 相关的"待探测"项全部有结论。

**阶段 0 执行结果（2026-10-23）**：两份文件已生成并提交（`docs/host-probe/pi-0.81.1.json`、`docs/host-probe/omp-18.12.5.json`）。pi 0.81.1 用 `scripts/e2e/run-probe.mjs` 跑完命令+扩展对话框，pi-goal 0.6.0 的三种形态单独跑；OMP 18.12.5 跑完 87 个内置命令、扩展 `select/confirm/input/editor/custom`、`ask` 单问/多问、`approve`。关键结论：

1. **pi 焦点**：没有 `getFocused()`；`ui.focusedComponent` 是数据字段且滞后一次事件；overlay 的 `setFocusInternal` 收到 `{component, overlayFocusRestore}`。焦点事件是权威。
2. **OMP 焦点**：`ui.getFocused()` 可用；所有对话框都经过 `setFocus`。
3. **OMP 入口**：扩展入口在 UI 上下文（`select`/`confirm`/`input`/`editor`/`custom`），工具上下文另有 `askDialog`/`approve`；只包 mode 原型会漏。工具上下文的方法源码已记录（`askDialog`/`approve` 的签名）。
4. **OMP 内置选择器不透明**：model/settings/session/tree/oauth 的焦点组件没有 items/selectedIndex 字段（部分只有 `children` 或空），阶段 3 只能先按快照提供按键；这是 §11 风险表的"部分对话框退化为快照"。
5. **OMP ask/approve**：ask 的问题/选项在入口参数里，状态在闭包；approve 的入口参数是 `{full,compact,session}`。两者都只能靠按键 + 重渲染确认，不能用字段读状态。
6. **pi-goal**：三种形态都是 `{render,invalidate,handleInput}` 的 Object，无字段；§4.6.6 的例外按 0.6.x 收窄启用。
7. **OMP 聊天区组件**：只有 `children`，构造器名压缩；白名单见 §4.4。
8. **导出**：`exportToHtml`/`exportToJsonl` 返回 Promise，路径取解析值，不是同步返回值。

### 阶段 1：基础设施 + 只输出命令

- `host.ts`、`focus.ts`、`origin.ts`、`gateway.ts`、`output.ts`。
- Gateway 只对**静态白名单**中的 pi 命令启用：附录 A"只有输出"中可提交且不替换运行时的命令。白名单外的命令仍走旧路径（含旧镜像）。白名单内的命令**绝不**进入 `runTuiCommand`。`/new` 走 `ctx.newSession()`；`/reload`、`/fork`、`/clone`、`/import` 保留原生处理器（§9 决定 21、22）。OMP 的同类命令在阶段 3 接入（§9 决定 23）。
- 本阶段不实例化 Broker；FocusTracker 只为 scope 结束判断和 OutputCapture 服务。新旧两套 hook 并存时，新 hook 是被动的（只观察，不发 Telegram 对话框消息），对话框画面仍由旧镜像负责。
- 修复草稿覆盖问题（白名单命令）。
- **验收**：pi 上 `/session`、`/compact`、`/name x`、`/new`、`/changelog`、`/share`、`/export` 从 Telegram 执行，宿主状态与终端执行一致，输出完整回传（含 `/compact` 完成后的结果），本地草稿不丢。**OMP 的同类命令不在本阶段验收范围，移到阶段 3。**

### 阶段 2：Broker + 扩展对话框

- `broker.ts`、`model.ts`、`render-telegram.ts`、`find-shape.ts`；适配器 1-4、10、11、12、13。
- §4.2.6 的持有逻辑抽取与接入；§4.5.1 的文本路由；§4.9。
- **验收**：
  - mock provider 触发 `ask`（现有 E2E 场景）和扩展 `select/confirm/input`：分别从 Telegram 和终端作答，另一端都自动关闭，agent 拿到的答案一致；
  - 从 Telegram 发 `/goals <topic>`，`propose_goal_draft` 的确认出现在 Telegram；
  - OMP `ask` 多问题从 Telegram 完整作答（走插件原有的 Telegram 作答路径即可，broker 化见 T3.0 与 §9 决定 25）。


**实测（2026-10-24，`npm run test:e2e:dialogs`，README 有该套件的说明）**

- pi 全绿：`select`/`confirm`/`input`/secret/`custom` 全部走 broker 方言，Telegram 与终端任一端都能作答，先作答者生效、另一侧键盘被撤销。
- OMP 此前从来不是 broker 方言，根因与 §4.6 无关：宿主把本包解析成两个模块实例，先打补丁的那份看到 TUI 模式，服务聊天的那份却看到 `host: unknown`，于是 `tuiBridge: full` 对它等于不存在。已修：捕获状态挂到进程级键上共享（`lib/tui-bridge.ts`）。
- 共享后实测：OMP 的 confirm/custom 变成 broker 方言且"终端先作答"通过；但 select/输入/`ask` 组件渲染进 overlay 且不夺取焦点，FocusTracker 只看到编辑器与 `progress`，适配器读不到条目，Telegram 只剩方向键。因此 `hostOwnsPrompts()` 暂时只对 pi 打开，OMP 的这些对话框继续由插件在 Telegram 作答。阶段 2 收尾补充：只关 `hostOwnsPrompts()` 不够，broker 仍在 OMP 上跟踪并接管交互（命令套件从 132/132 掉到 119/126，`/exit`、`/tg-cwd-disconnect` 失败），所以 broker 与它共用同一个宿主开关，OMP 整体回到收口前的行为（决定 27）。
- 剩余 OMP 缺口 = §4.6 适配器要认识 OMP 组件。实测结论与原先设想不同：不需要去 overlay 子树里猜字段——OMP 的 hook 对话框**确实**夺焦点，缺的是①分类（行标签在私有字段、类名被压缩，形状判定落空）与②读取（`render(80)` 去色帧里解析标题/行/`❯` 当前行）。两者落地后 `hostOwnsPrompts` 里的主机限制已删除，OMP 与 pi 共用同一个开关（决定 28）。
- 宿主模式下 Telegram 发起的命令拿的是**宿主自己的 context**(`setUIContext` 换的是 runner 的 UI,命令上下文是它的代理)。插件独有的 UI 成员在宿主侧不存在,代理必须回落给插件实现:嵌套 `menu` 键盘(以及它的逆操作 `closeMenu`)是插件控件,`/tg` 的管理界面靠它在宿主模式下逐层展开,否则 `ctx.ui.menu` 是 `undefined`,菜单直接消失。
- 插件自己的管理命令(`/tg` 系列)背后没有宿主组件,不参与 broker;宿主模式改变的只是宿主组件与扩展对话框由谁作答。
- 入口 hook 必须打在**宿主的 UI context**上：`attachEntryHooks` 原来只在捕获宿主时跑一次，读的是"当时 runner 里装着的 context"。如果那一刻插件的交换正生效，宿主的真 context 就被跳过了，之后所有对话框都没有 `EntryInfo`，适配器只能给快照（`modelKind:"snapshot"`），输入类对话框变成一堆方向键、按键送不进去。现在代理暴露 `__piTelegramPlusRoutedBaseUi` 供解包，并且 FocusTracker 每秒的 verify tick 重跑一次 hook（`hookEntryMethods` 按对象打标记，重复调用无副作用）。

### 阶段 3：列表、设置、登录

**v6 拆分**：阶段 3 拆为 3A 清理与对齐 → 3B 扩展对话框 → 3C OMP 内置选择器 → 3D pi 内置选择器 → 3E 收尾验收，3A 再拆为 4 个检查点，详见任务清单"阶段 3 拆分"。下面的原始描述保留作背景。

- 适配器 5-9；所有命令切换到 Gateway；删除三个命令集合常量。
- **OMP 只有输出的命令接入 Gateway**：先实现 `InfoPanelAdapter`/快照面板截获，覆盖 `showCommandReport`、`showDebugSelector`、`showUsageDashboard`、`showExtensionsDashboard`、`showAgentsDashboard` 等全屏报告；再把 `/status`、`/usage`、`/stats`、`/context`、`/changelog`、`/help`、`/skills`、`/plugins`、`/extensions`、`/tools`、`/agents`、`/mcp`、`/plan`、`/jobs`、`/todo`、`/memory` 加入 OMP 白名单。面板必须能在 Telegram 看到正文，不能只回 ack。
- **验收**：`/model`（含搜索、翻页、当前值）、`/resume`、`/settings`（含切换值、子菜单）、`/login`（多步，含 API key 输入且 Telegram 上不出现明文）、`/logout`、`/scoped-models`、`/tree`、`/fork`（编辑器文本发到 Telegram，本地草稿恢复）在 pi 和 OMP 上可用，结果状态与终端一致；**OMP 的只有输出命令从 Gateway 执行且面板正文被截获**。

### 阶段 4：终端专属命令与收尾

- §4.8 映射表全部落地；快照兜底在未知组件上验证。
- **验收**：`/copy`、`/export`、`/hotkeys`、`/quit` 的等价行为；构造一个未知 custom 组件，Telegram 能看到截图并能取消。

### 阶段 5：清理

- 删除旧镜像代码、`tui-selector.ts`、`tui-bridge.ts`；旧回调前缀改为"已过期"；配置迁移；文档更新。
- **验收**：§7.2 的 parity 测试在 pi `1.4.0` 和 OMP `18.12.x` 上通过，"待迁移"清单为空（§0.1）。

---

## 7. 测试方案

### 7.1 单元测试

- **假宿主**（`lib/__tests__/_fake-host.ts`）：最小 mode 对象，含 `ui`（`setFocus`、`showOverlay`、`hideOverlay`、`requestRender`、`focusedComponent`/`getFocused`、可模拟的 `setFocusInternal` 绕过路径）、`editor`（`getText`、`setText`、`handleInput`、`onSubmit`）、`chatContainer`、`session`、`showStatus`/`showError`/`showWarning`。命令处理器分别模拟 await 型和立即返回型。
- **真实组件契约测试**：pi 的组件类可从 `@earendil-works/pi-coding-agent` import。每个适配器至少用一个真实实例测 `detect/read/act`（包括 `SettingsSelectorComponent` 的子菜单、`SessionSelectorComponent` 的嵌套 `sessionList`）。依赖太重无法实例化的，测字段形状并在测试中写明原因。作用：宿主升级改字段时测试先失败。
- **焦点分类**：editor / inert / progress / dialog；`setFocusInternal` 绕过时靠校验发现关闭。
- **Broker 状态机**：Telegram 先操作、终端先操作、回调在焦点离开后到达、generation 过期、按 key 找不到、`/stop`、对话框被替换、子菜单嵌套。
- **scope 结束**：await 型长任务的完成输出不丢；立即返回型对话框期间 scope 不结束；多步对话框之间短暂回到编辑器不结束；30 分钟上限。
- **草稿保护**：§4.2.4 表中四种情况各一个用例。
- **文本路由**：§4.5.1 表中四种文本各一个用例；不同 thread 不受影响。
- **密钥**：输入被删除、摘要不含明文；OutputCapture、Broker、renderer 三个来源的文本都被脱敏；Telegram turn 中输入的密钥同样生效；含 `& < >` 的密钥被正确替换且 HTML 结构完好；短于 8 字符的输入不登记；`/new` 后清空。
- **对话框守卫**：Broker 会话或原生输入流活动时，`/tg`、`/cwd` 和宿主命令被拒绝，`/stop`、`/status` 放行。
- **文本输入**：回复其他消息的文本不被当作输入。
- **消息复用**：命令 scope 内的多步对话框和 progress 复用同一条消息；turn 内的对话框各自新发；progress 结束后消息被改为完成状态并移除键盘。
- **内容域**：Telegram turn 期间宿主加入的 assistant/tool 组件不被截获（renderer 已发送）；`notify` 在 `on` 模式下只发一次；`chatContainer.clear()` 后的历史重建不被截获；单个 scope 超过 20 个组件时被折叠。
- **扩展命令完成信号**：空闲路径下 `onSubmit` 先返回、`session.prompt` 稍后开始并弹出对话框，scope 不提前结束；主循环忙、文本在 `pendingUserInputs` 中排队超过 2 秒时仍能匹配；流式路径中 `session.prompt` 在 `onSubmit` 内同步调用时能被匹配；内置命令（`/session`）提交后不等待，下一条 Telegram 命令不会被误判为 busy。
- **输出内容域**：agent 流式时从 Telegram 发 `/session`，信息块被截获；同时 assistant/tool 组件不被截获。
- **hook 重新安装**：替换 `mode.editor`（模拟 `setCustomEditorComponent`）和 `mode.session` 后，tick 能重新包装，提交、本地输入标记和 `session.prompt` 匹配继续有效。
- **entry 关联**：`showExtensionConfirm` 嵌套 `showExtensionSelector` 时 kind 为 `confirm`；异步 custom 工厂延迟 1 秒返回时 entry 仍能关联。
- **分发优先级**：`pluginOnly`、映射表、宿主内置（含 `/debug` 重名）、兜底、拒绝。
- **回调编码**：所有组合 ≤ 64 字节。

### 7.2 E2E parity（改造 `scripts/e2e/audit-parity.mjs`）

现在的判定是"Telegram 收到的是不是纯文本或无效按钮"。改为**状态等价**：

1. 每个命令在两个全新的隔离宿主中分别执行：A 用 tmux 发按键在终端操作，B 从 mock Telegram 发命令并点按钮，两边执行相同的操作序列。
2. 执行后导出宿主状态快照：当前模型、思考档位、会话文件、settings 文件、认证文件中对应字段。
3. A 和 B 的快照必须一致。
4. 额外断言：Telegram 上列出的选项集合等于组件的完整列表。

保留现有的 Bot API 契约校验（`scripts/e2e/telegram-contract.mjs`）。

---

## 8. 风险与降级

| 风险 | 影响 | 缓解 |
|---|---|---|
| 宿主升级改了私有字段或方法名 | 适配器识别失败 | 只支持固定版本（pi `1.4.0`、OMP `18.12.x`），版本不符启动即报错；升级前先读新版本源码、跑通契约测试和 E2E 再放开版本（§0.1） |
| OMP 的实际结构与预期不同 | OMP 部分对话框退化为快照 | 阶段 0 已探测：OMP 内置 model/settings/session/tree/oauth 组件没有可读字段，阶段 3 先按快照实现；扩展入口参数仍提供结构化模型（§4.6.5） |
| 两端同时操作 | 竞争 | 宿主模态对话框只生效一次；Broker 操作前做焦点校验；回调带 sessionId + generation；按 key 定位 |
| Telegram 提交命令时终端开着对话框或上一个命令未结束 | 命令落不到编辑器 | Gateway 拒绝并提示（§4.2.3） |
| 宿主绕过 `setFocus` 改变焦点 | 关闭事件丢失 | 焦点校验（§4.1.3） |
| 输出与 agent 消息重复 | 刷屏 | 只截获有归属的 scope 输出 |
| Telegram 端连续操作导致编辑超频 | 429 | 每 chat 1 次/秒；模型无变化不编辑；终端变化不触发编辑 |
| hook 代码抛异常 | 影响宿主 | 原则 7 |
| 密钥经过 Telegram | 泄露 | §4.7.4（固定行为） |
| 宿主为发起者写入编辑器的文本（`/fork`） | 覆盖本地草稿 | §4.2.4 |
| 缺省值迁移改变老用户行为 | 用户意外 | CHANGELOG 单列行为变更 |

---

## 9. 已确认的决定

| # | 问题 | 决定 |
|---|---|---|
| 1 | 本地发起的对话框是否推送到 Telegram | **不推送**。谁发起，谁显示。本地 agent turn 中的 `ask` 也不推送 |
| 2 | `tuiBridge` 是否保留 `off` | ~~本次保留，不清理~~ **v6 推翻：立即删除 `off` 模式和插件原生实现**（决定 48） |
| 3 | `/quit` 能否从 Telegram 执行 | **允许**，二次确认 |
| 4 | 终端变化是否同步到 Telegram | **不同步**。执行前按实时状态和 key 定位 |
| 5 | 命令 scope 何时结束 | `onSubmit` 和持有都结束 + 无活动会话 + 焦点在编辑器 + 1.5 秒无输出；30 分钟上限（§4.3） |
| 6 | 草稿何时恢复 | scope 结束时；本地用户已在编辑则不动；宿主为发起者写入的文本发到 Telegram 后恢复草稿（§4.2.4） |
| 7 | enqueued turn 的归属 | Gateway 复用现有持有逻辑；归属按 Telegram UI 栈顶判断（§4.2.6、§4.3） |
| 8 | 缺省值迁移 | `commands`/`full`/未设置 → `on`，作为行为变更写进 CHANGELOG（§4.10） |
| 9 | OutputCapture 截获什么 | agent 消息、工具调用只由 `renderer.ts` 发送；OutputCapture 负责宿主状态/错误/警告（含 `notify`），以及命令 scope 内、非流式、非重建、非消息类的聊天区内容（§4.4）。`on` 模式下 `notify` 不再直发 Telegram（§4.9） |
| 10 | 扩展命令的完成信号 | hook `session.prompt`，匹配本次提交文本的那次调用，其结束计入 scope 结束条件（§4.3） |
| 11 | 本地命令镜像 | 按决定 1 删除（§4.9 第 5 条） |
| 12 | pi-goal 的不透明 custom 组件 | 先按阶段 0 探测结构化；探测证明无可用字段时，按 §4.6.6 开**唯一、收窄**的例外：仅白名单形态，文本只用于识别和读选项，操作全部走按键，绑定版本 |
| 13 | 输出截获判据 | 不用 `isStreaming`；按组件身份排除 agent 渲染的组件（§4.4） |
| 14 | 脱敏层位置 | 在三个发送源转换前替换，传输层不替换；短于 8 字符不登记（§4.7.4） |
| 15 | 完成信号适用范围 | 只对非内置命令登记，先登记后提交；过期按"空闲 + 无排队 + 主循环等待输入"连续 500ms，60 秒上限（§4.3） |
| 16 | 对话框打开期间的 Telegram 命令 | 只放行 `/stop` 和 `/status`，其余回复"请先处理当前对话框"（§4.2.2 第 0' 步） |
| 17 | OMP 扩展入口 hook 打在哪 | **UI 上下文**，不是 `InteractiveMode` 原型。OMP 的扩展/工具通过各自的 `ctx.ui` 调用（`select/confirm/input/editor/custom/askDialog/approve`），阶段 0 证明 mode 原型的 `showHook*` 不会为扩展上下文触发 |
| 18 | OMP 内置选择器（model/settings/session/tree/oauth）没有可读字段 | **先降级为快照**，只提供 ↑↓/Enter/Esc；不解析渲染文本伪造原生列表。若后续 OMP 版本暴露字段，再按探测结果升级 |
| 19 | OMP 的 `mode.editor.onSubmit` 在捕获时不存在 | 交给 §4.1.1 的每秒 tick 安装；捕获只记录字段名，不假设初始化顺序 |
| 20 | `/export` 的路径来源 | `exportToHtml`/`exportToJsonl` 返回 **Promise**；等待解析后的字符串作为路径。`/share` 内部调用同一方法，按 scope 标签区分（§4.8） |
| 21 | `/reload`、`/fork`、`/clone`、`/import` 是否提交给宿主编辑器 | **不提交，保留原生处理器。** 提交给编辑器会走 `runtimeHost` 的会话替换路径，绕过 pi 的 `withSession` 顺序；扩展运行时会被重新加载，而旧轮询实例尚未释放，单例协调器会拒绝新实例（"another local pi instance is already polling this bot token"）。原生处理器已经在宿主控制 API 内完成同样的状态变更。 **（v6 修订：`/fork`、`/clone` 改为交给宿主，见决定 52；`/reload`、`/import` 不变）** |
| 22 | `/new` 如何执行 | **调用宿主 `ctx.newSession()`，不提交编辑器。** 编辑器路径走 `handleClearCommand()` → `runtimeHost.newSession()`，同样会绕过 `withSession` 并触发轮询实例交接；命令上下文里的 `ctx.newSession()` 是宿主支持的替换入口。命令 scope 仍需保存/恢复草稿。 |
| 23 | OMP 何时接入 Gateway | **推迟到阶段 3。** 阶段 0 证明 OMP 的 `/status`、`/usage`、`/stats`、`/context`、`/skills` 等走 `showCommandReport` 全屏面板，面板内容不在 `chatContainer` 的 `addChild` 流里；阶段 1 没有 `InfoPanelAdapter`，接入只会回一条 ack 而没有正文。阶段 3 先做面板截获，再把 OMP 的只有输出命令加入白名单。 |
| 24 | `session.prompt` 完成信号放在哪一步实现 | 决定 10 和 15 不变，但随 Gateway 接线（§4.2.3、§4.3）一起实现：只对非内置命令登记，内置命令立即置 `promptDone = true`，另有 500ms 安静窗口和 60 秒上限。此前 `origin.ts` 里的半成品对所有命令都等 prompt，而且没有安装 hook，会让每个只输出命令空等到 60 秒上限，因此删除，不留半个机制。 |
| 25 | OMP 的扩展 `select`/`input`/`ask` 何时走 broker | **移到阶段 3 的 T3.0，且更正原先的前提。** 阶段 2 收尾复测（`docs/host-probe/omp-18.12.5.json` 的 `focusEvents` 与 `conclusions.dialogFrames`）：OMP 的 hook 对话框**会**切换焦点——`select`/`confirm`/`input` 入口调用之后紧接 `via:"setFocus"`，焦点组件是 `children` 容器（`QT`、`FD`、`Fy`），`askDialog` 的组件带 `callbacks`+`options`（`Ej`），扩展自定义对话框是带 `render`/`handleInput` 的普通对象；原先记录的"不调用 `setFocus`"复测不再出现（那次采集时插件在 Telegram 原生作答，宿主的对话框有没有真的建起来无法确认），以本次数据为准。缺的不是焦点，而是识别与读取：OMP 把标签放在私有字段里（行组件 own keys 为空），`lib/tui/focus.ts` 的 `classify` 形状判定全部落空、构造函数名又是压缩产物，于是分类落到 `"progress"`，适配器也读不到条目。所以 §4.1.3"按焦点识别对话框"的接口不用改：绑定了入口条目的焦点组件就是对话框；标签取自组件画出的帧（probe 已按组件形状记录去色帧文本），操作继续走 `act()` 的按键注入。在那之前 `hostOwnsPrompts()` 只对 pi 打开（决定 27），阶段 2 验收里"OMP `ask` 多问题从 Telegram 完整作答"允许继续由插件在 Telegram 作答；阶段 2 其余验收不变。 |
| 26 | 插件原生提示和镜像对话框同时在等同一条文本时给谁 | **给插件在这个 chat 里发起的原生提示**：控制器先 `deps.ui.resolveInput`，再问 Broker。与 §4.5.1 单表模型的"最新流优先"一致——谁最后问，谁拿答案。实测故障（合并前）：终端里遗留的快照镜像把密钥提示的回答当搜索词吃掉，那条提示接着把下一条 `/probe-custom` 命令当成自己的回答删掉，两个步骤一起失败。`registerExternalInput` 合并两张表的工作随 T3.6 一起做（§4.5.1 实现现状）。 |
| 27 | Broker 何时启用 | **和 `hostOwnsPrompts()` 共用同一个宿主开关。** 只关 `hostOwnsPrompts()` 时 broker 照旧跟踪焦点、建模对话框、抢等同一条文本：阶段 2 实测 OMP 命令套件从 132/132 掉到 119/126，`/exit` 与 `/tg-cwd-disconnect` 也失败。收口条件是 `tuiBridge: full` + 宿主桥可用（`lib/controller.ts` 里 DialogBroker 的 `enabled` 直接调用 `lib/tui-bridge.ts` 的 `hostOwnsPrompts`）。该开关曾短暂只对 pi 打开（`getHost() === "pi"`），因为当时 broker 读不懂 OMP 的对话框；分类与读取补齐后该条件已删除，打开的验收线仍是命令套件不低于阶段 1 基线 132/132（任务清单 T3.0 完成标准，决定 28）。 |
| 28 | OMP 的对话框怎么分类、什么时候算关闭 | **分类看入口条目，关闭要等确认。** 焦点组件绑定了入口条目、或落在"入口调用未结束"窗口内的首次聚焦，即判为 `dialog`（`FocusTracker.entryFor`；OMP 的 UI context 入口没有组件字段，靠待决条目关联），不再依赖类名或形状。行藏在私有字段里的组件由按帧读取的适配器处理：`render(80)` 去色文本解析标题、行、`❯` 标记的当前行与页脚按键，操作仍走按键注入，不要求宿主暴露私有字段。**关闭**：焦点回到编辑器必须持续 250ms 才算关闭（§4.1.3 分类表已按此补充），直接跳到另一个对话框则立即算关闭。**progress 不建会话**：带 `signal`/`abortController` 的 spinner 不是对话框，broker 不为它发 Telegram 消息（理由见 §4.1.3），镜像照旧显示。broker 正在画对话框时，镜像继续播报画面但不再给出自己的方向键键盘（同一问题只有一副键盘）。**为什么关闭看焦点而不看入口 Promise**：入口 Promise 结束只用来让入口记录失效（`lib/tui/entry.ts` 的 `retire`），会话关闭仍以焦点为准；确认窗口取 250ms（`lib/tui/focus.ts` 的 `FOCUS_CLOSE_GRACE_MS`）而不是 1.5 秒，因为实测 OMP 重绘时焦点只回编辑器一帧，250ms 足以过滤，更长的窗口会让对话框真正关闭后 Telegram 键盘多停留。多题 `ask` 两题之间不会被提前关闭，已由 `test:e2e:dialogs`（OMP、pi）验证。pi 与 OMP 用同一规则。 |
| 29 | 焦点交给容器组件时会话怎么办 | **换按键目标,不换会话。** OMP 打开 overlay 后会把焦点从对话框交给承载它的 `children` 容器(`QT`),两者的入口条目是同一个对象。若按新组件重建会话,已发到聊天里的按钮全部作废(点一下回"这个菜单已经过期"),多步流程原地死掉。所以 broker 比较 `FocusTracker.entryFor(component)` 与会话记录的 `entry`:同一个条目就只改 `session.focus`(按键目标),消息、键盘、`generation`、pending 输入全部保留,并新增 `session.subject` 记录真正持有状态的组件——读取、适配器 `act`、按键注入都发给 `subject`,因为容器只是转发。 |
| 30 | progress 抢焦点算不算对话框关闭 | **不算。** spinner(`BorderedLoader` 一类)拿焦点是为了让 Esc 能打断回合,它后面的问题还开着。旧实现看到 `progress` 就 retire,把键盘从正在等的消息上撤走:OMP 的多题 `ask` 里"下一题/Submit"永远点不到。现在 `progress` 既不建会话也不镜像(决定 28 不变),但已有会话继续存活并可注入(`canDrive` 允许"焦点是 progress"),真正的关闭仍由焦点回到编辑器(250ms 确认)或跳到别的对话框判定。 |
| 31 | 对话框没答完又来了新命令 | **只替本聊天按 Esc;别处的对话框只说明,不代答。** 宿主把一个未答的对话框排在所有后续命令之前,所以命令到达而未答的对话框仍在时,必须分清它是谁的。收窄成三条:① 会话的 Telegram 消息就在本聊天 → 替用户按一次 Esc、只摘掉那条消息上的死键盘(不覆盖正文:新命令按 §4.7.3 就在同一条消息上作答),并在聊天里补一句"已关闭未回答的对话框:<标题>";焦点已回到编辑器(会话只是被还没结束的命令作用域吊着)时改为**静默回收**,不按 Esc 也不播报,否则通知会抢在命令输出前面到。② 不是本聊天的对话框——包括终端自己打开的、以及从没发给任何聊天的——**一律不代答**:`abandonFor` 返回 `blocked`,controller 回"终端上有一个未完成的对话框,请先在终端处理,或发 /stop。",并且**不把这条命令提交给宿主**(刚开的作用域以 `error` 结束),免得它排在别人的问题后面静默等 30 秒。原先"没人认领的对话框算成本聊天的、顺手关掉"的做法废弃:那是替别人做决定,而且会吃掉终端里正要看的答案。 |
| 32 | 镜像与 broker 怎么分工 | **按消息划分所有权,不按聊天。** 旧写法是"本聊天有 broker 会话 → 镜像整体不启动",一个被遗留的对话框能让之后每条命令都没有输出。现在镜像照常启动,只在 broker 正画的那条消息上让位;键盘仍只有一副:`mirrorsFor` 只统计**画过本聊天消息**的会话,终端自己拥有的会话不得夺走镜像按键。命令回执改成"选择器已在上面的消息里"的条件同样收紧为"本次命令打开、且画在本聊天"(比较 `DialogSession.openedAt` 与提交时刻),否则照常镜像输出。 |
| 33 | `ui.menu` 归谁 | **宿主有 `menu` 就用宿主的。** 代理层曾把 `menu`/`closeMenu` 强行留给插件的原生键盘,于是同一个问题既有插件键盘又有宿主对话框(宿主那份由 broker 镜像),点击落到哪一边看运气,管理菜单(`/tg` 系列)整条链路时好时坏。删掉这条特例后:宿主没有 `menu` 时代理仍回落到插件实现,宿主有则交给宿主,只有 broker 一个出口。 |
| 34 | 没有适配器能建模的屏幕 | **交回屏幕镜像,broker 不建会话。** 走 `SnapshotAdapter` 的对话框只能显示整屏文本,给不出能真正作答的按钮;broker 把它发到聊天里,等于用一副假键盘抢走消息,同时按 §4.5 让真能注入按键的镜像闭嘴(实测 `/tg` 系列出现"broker 版菜单 + 插件原生菜单"两副键盘,点击落到哪边看运气)。现在 `open()` 选中 snapshot 适配器就直接返回(只留一条 debug),屏幕仍由镜像播报并可用方向键操作。 |
| 35 | 宿主给的选项串带缩进和"当前值"点,怎么和帧上的行对上 | **两边都去掉装饰再比。** OMP 递给扩展的选项串自带缩进和当前值标记(如 `"  hidden"`、`"● brief"`),帧里画的是光标标记加同样的文本,逐字比较永远对不上:`act` 只能拒绝(`frame marks no known row`),`/tg` 的配置子菜单和 `/model` 整组点不动。`longestLabelMatch` 先把标签去掉前导空白与前导状态符号再比,仍取最长匹配(一行的文本可能以另一行开头)。 |
| 36 | 方向键按几下按什么算 | **按帧上真正显示的行算。** 数据在私有字段里时,选项全集和屏幕上的行不是一回事:终端搜索或翻页后再按全集计数,Enter 会打在错误的行上。`frameRows` 给出可见行与高亮行的位置,步数在两者之间计;不在屏幕上的行直接拒绝,不猜。 |
| 37 | generation 什么时候递增 | **用户能按的按钮变了才递增。** 旧写法每次 redraw 都 +1,而 OMP 会反复重绘同一个问题(焦点闪一下也算),于是用户眼前的键盘被判"列表已变化,请重新选择",实际什么都没动,多题 `ask` 走不到 Submit。现在比较两次绘制的"按钮面"(按钮文字 + 回调 arg→key):相同就保留原 generation;比较前去掉 `▸`/`❯`/`→` 这类终端自己的光标标记——它嵌在按钮文字里,但每个按钮都按自己的 key 解析到实时模型,移动它不改变任何按钮的含义。换页会改变按钮面,照常递增,而 arg 里带页码,旧按钮仍按自己的 arg 解析。 |
| 38 | 宿主接管提示后,只发通知的命令怎么回到聊天 | **命令上下文的 `ui` 换成路由代理,但只在宿主自己不投聊天时。** `hostOwnsPrompts` 对 OMP 放开后,`runCommandHandler` 把命令上下文原样交给宿主,`ctx.ui` 成了宿主的原始 UI:`notify` 只打在终端,`/changelog`、`/copy`、`/debug` 这类只回一句通知的命令在 Telegram 端变成 30 秒超时。现在 host 模式下也用 `createHostPromptUi(hostUi, telegramUi)` 包住命令上下文:提示仍归宿主(终端能答)。但 pi 交给命令上下文的 `ui` 本来就是插件的路由上下文(带 `__piTelegramPlusRoutedUi` 标记),它的 notify 已经会投给聊天,再复制一份就变成同一条消息发两三遍;`createHostPromptUi` 因此先看这个标记,已投聊天的直接透传,通知每条只发一次。 |
| 39 | 编辑消息失败要不要顺手摘掉键盘 | **不摘。** `show()` 重绘失败时原先会补一次 `removeInlineKeyboard`,理由是"内容没变或被限流"——可这两种失败都说明不了对话框的死活,问题还开着,却把唯一能作答的按钮撤了,聊天里从此只能干等。现在失败只记日志,下一次重绘自然补上;真正该摘键盘的只有 `publish()`(对话框确实结束)和 `abandonFor`(替用户按了 Esc)。 |
| 40 | "有 entry 就算对话框"和"是 loader 就算进度"谁先 | **loader 先。** 认出一个没有可读行的对话框,靠的是去认领宿主记下的 entry(`entryFor` 会把它绑到当前组件上),这个动作是有代价的:转圈面板先拿到焦点时,它会带着问题的身份被判成 dialog,还顺手把 entry 用掉,真正的对话框随后到达就变成无名快照(决定 28/30 想防的正是这个)。所以 `classify` 的顺序改成:形状判定 → loader/signal 判定 → 才允许 entry 认领。 |
| 41 | OMP 对话框通过什么读取和操作 | **collab + TSP，不读画面、不模拟按键**（§4.11，用户 2026-10-24 确定）。依据 OMP 源码与 S20/S21c/S22 实测：扩展 select/editor/ask/approve 走 `mode.collabHost.requestGuestUi`；其余对话框与内置选择器走组件的 `describe()`/`handleNativeEvent()`。取代决定 18，以及决定 25、28、35、36 中关于 OMP 画面读取的部分。 |
| 42 | 本地发起的对话框会不会经 collab 推到 Telegram | **不会。** 只有存在 Telegram 发起的命令作用域或 Telegram turn 时，桥接才接管；否则返回 `null`，只在终端显示（决定 1）。 |
| 43 | 用户自己开 `/collab` 时怎么办 | **让位给真实 collab 宿主，不另找路径。** 桥接发现 `mode.collabHost` 被替换就停止接管；期间 Telegram 发起的 select/editor/ask/approve 直接回复"终端正在 /collab 协作，请在终端或协作端处理"；collab 结束后重新挂上。 |
| 44 | OMP 结构化通道的版本约束 | **绑定 `18.12.x`，不符即失败，不做降级**（用户 2026-10-24 确定："版本不对直接失败，不要搞多套"）。版本不符或读不到版本时插件明确报错，OMP 对话框不桥接；支持新版本须先核对源码并跑通 E2E（§4.11.4）。同理废弃 S8（`558d574`）"版本不符退回快照"的做法，相关代码随 T3.2g 删除。 |
| 45 | 现有 broker 在 OMP 上怎么调整 | **保留为中枢，适配器换成结构化来源**（用户 2026-10-24 要求现有 broker 也改为新方案）。会话来源增加 collab 请求；OMP 上的焦点 + 画面 + 按键路径在 T3.2g 删除。 |
| 46 | 支持哪些宿主版本 | **只支持 pi `1.4.0` 与 OMP `18.12.x`，不兼容多个版本**（用户 2026-10-24：只对齐 1.4.0，不再兼容多个版本）。版本不符启动报错；删除多版本测试矩阵与仅为旧版本存在的兼容代码。 |
| 47 | 识别不了的对话框怎么办 | **明确告知，不做半吊子操作**（用户 2026-10-24）。取消快照方向键与"交回屏幕镜像"（决定 34 作废），由 `UnsupportedAdapter` 告知并只提供"取消"。 |
| 48 | `off` 模式与插件原生实现 | **立即删除**（用户 2026-10-24，推翻决定 2）。桥接不可用时启动报错；`pluginOnly` 管理命令保留。 |
| 49 | 旧路径什么时候删 | **现在删，先于迁移**（用户 2026-10-24：当前不在使用，删除不影响）。未迁移命令暂无输出，由 E2E"待迁移"清单区分预期失败与回归。 |
| 50 | 宿主行为以什么为准 | **以宿主源码为准**：先读 pi `1.4.0` / OMP `18.12.5` 源码确定前提，运行时实验只用于验证（此前两次在未读源码的情况下靠运行时实验摸索，浪费多轮）。 |
| 51 | Telegram 发来的 `!命令` / `!!命令` 由谁执行 | **交给宿主执行，插件只保留危险命令确认**（用户 2026-10-25 同意）。pi 1.4.0 与 OMP 的编辑器都原生支持 `!`/`!!`，宿主执行前会先发 `user_bash` 事件让扩展接管或拒绝（pi `interactive-mode.ts` 的 `handleBashCommand`）；插件直接调用 `session.executeBash` 会**绕过这个扩展钩子**（例如沙箱、权限类扩展）。因此插件不再直接调用 bash 执行器，而是先按 `bashConfirm` 策略在 Telegram 确认（插件自己的远程执行安全闸门，宿主没有对应概念），确认后经 gateway 把原文提交给宿主编辑器，输出照常回传。任务 D3b。 |
| 52 | `/fork`、`/clone` 交给谁 | **交给宿主执行**（用户 2026-10-25 同意；修订决定 21）。决定 21 的理由（编辑器提交会替换运行时、轮询单例冲突）已被 `e046a98`（同进程锁接管）与 `bf81fd5`（破坏性调用前提交游标）消除。规则统一为：有选择界面的命令（`/fork`、`/clone`）交给宿主，其选择器由适配器接管（pi：`UserMessageSelectorComponent`；OMP：TSP），之后删除插件自带的消息列表；没有界面、只调用控制接口的命令（`/new`、`/reload`、`/import`）继续调用宿主控制 API。分别并入 3C、3D，3E 用 E2E 验证运行时替换。 |
| 53 | 扩展对话框在两个宿主上怎么接到 Telegram | **扩展 UI 竞答（§4.12），取代 collab 桥接**（用户 2026-10-24 选定竞答方向；S25/S25b 2026-10-25 在两个宿主上证实）。修订决定 41：扩展 select/confirm/input/editor/ask/approve 走竞答，TSP 只用于内置选择器、`custom` 与仪表盘。决定 43（`/collab` 让位）作废：竞答不占用 `collabHost`。 |
| 54 | 对话框开着时，Telegram 发来的普通文字怎么处理 | **对话框收文字（输入框、带搜索的列表）就交给对话框；不收文字时不提交为提示词，回复"终端上有一个对话框正在等待（<标题>），请点按钮作答，或发 /stop 取消"。** `/` 命令照 §4.5 规则 6 先关掉本聊天的对话框再执行（3E 发现 D2 后 gateway 路径漏了这一步，F9 `a4a2dbe` 补上）。依据：与终端一致——对话框占着焦点时终端里发不出提示词；主控 2026-10-25 定（F8 `7589384`），用户可改。 |
| 55 | OMP 子代理会话里插件做什么 | **子代理里什么都不做，主会话独占运行时**（2026-10-26，issue #13/#15）。OMP 为每个子代理在同一进程里再次调用扩展工厂（`ctx.agent.kind === "sub"`，OMP `extensibility/extensions/types.ts`）。`lib/main-only-pi.ts` 把 `pi.on` 的处理器包成子代理里不执行；"接管运行时"（拆旧运行时、写 `runtimeState.dispose`）只在主会话的 `session_start` 里发生，工厂开头不再无条件拆除。pi 没有子代理、也没有 `ctx.agent`，缺字段一律当主会话。**已知未处理**：pi 上第三方扩展用 SDK 开嵌套会话会再次加载本插件，pi 没有可区分的字段，不补防护（没有可靠判据，不做猜测式防护）。工厂里直接做的事（协调定时器、controller 内的 broker/gateway 定时器）在子代理实例里也会启动：`mainOnlyEvents` 第一次被子代理上下文触发时调用 `disposeInertRuntime` 只拆这个实例自己的定时器和 controller，不碰共享状态（状态栏、进程级菜单刷新、协调器租约、`runtimeState`）（e97081a，真实 OMP 追踪：子代理实例创建 8ms 后被清理，其协调定时器 0 次触发）。命令/工具注册仍留在子代理自己的运行器上。 |
| 56 | 宿主对话框方法的包装怎么去重 | **按 FocusTracker 实例限定作用域；宿主读取不稳定时才用对象标记**（2026-10-26 初版，2026-10-27 修订；issue #16，及其引起的 pi 回归）。两个宿主的事实（都已实测）：OMP 给扩展的工具 UI 对象、pi 的 TUI 对象的 `setFocus`，**每次读取都返回一个新函数**（读取不稳定）；pi 会在同一进程里重建插件运行时（`/new`、`/reload`），每次新建一个 FocusTracker（`lib/controller.ts` 的 `new FocusTracker()`）。要求：同一个跟踪器对同一个对象的同一个方法只包一层（否则 OMP 上每个 tick 叠一层，约 3000 次后栈溢出）；而每个新跟踪器必须装上自己的一层（否则事件只送到已销毁的旧跟踪器）。实现（`lib/tui/install-marks.ts`）：三类钩子——入口钩子 `hookEntryMethods`、竞答 `installRace`、`hookMethod`——的去重状态都按 `scope`（FocusTracker 实例）存放在 `globalThis[Symbol.for("pi-telegram-plus.install-marks…")]` 下（跨模块实例共享）；函数身份（被包的函数和包装函数都登记）挡住读取稳定的宿主上的重复包装，对象标记 `hasStickyMark` 只在连续两次读取得到不同函数时生效。`output.ts` 的 `hookMethod` 调用不传 `scope`，仍按进程级去重。**初版的错误**：初版把去重做成"按（对象，方法）、进程级共享、不分跟踪器"，并删掉了按跟踪器的函数身份去重。在 pi 上造成三处回归（均已用追踪定位）：入口钩子在运行时重建后不再装上（旧版每个 `showExtension*` 装 4 次，初版 1 次）；`installRace` 登记全局集合而入口钩子查跟踪器集合，`select/confirm/input` 每个 tick 叠一层（425 次 vs 约 45 次）；`setFocus` 等焦点钩子被粘性对象标记挡住（`stableRead=false, sticky=true -> SKIP`），新跟踪器收不到焦点事件，`/model` 对话框被登记为无来源并一直开着，挡住后续所有命令。修复：1e44c29、8e1ba00、b09184b、c5a9030、8d989f7；`pi:main` 由 53/64 恢复为 75/75。**教训**：改"谁和谁共享状态"的范围时，要在两个宿主上把命令、对话框、TUI bridge 三套 E2E 都跑完。 |
| 57 | OMP 登录对话框怎么接到 Telegram | **专用适配器 `tsp-login`，两阶段同一个适配器**（2026-10-26，issue #14）。真实 OMP 上依次发现并修了四层问题：焦点分类把带 `signal` 的登录对话框判成 progress（`describesLoginSheet`）；适配器在对话框刚出现（只有链接）时就选定，后出现的输入框不会再换适配器；文字在 `p.spans` 而不是 `p.text`、标题在内层 `overlay.p.head`、状态在 `spinner.p.label`；输入框 `TextFormField` 只有 `describe()` 没有 `handleNativeEvent()`，读取下钻只要求 `describe`（`describableChild`），发事件仍用 `asComponent`。只有链接的阶段用 `progress` 模型（普通文本，链接可点；`info` 用 `<pre>`），有输入框后复用 `tspInputAdapter` 的读写；`input` 模型新增可选 `detail`（说明、设备码、链接）。 |
| 58 | 对话框中途才变成密钥输入时，用户消息要不要删 | **按当前模型判断，而不是对话框打开时的快照**（2026-10-26）。`isSecretSession`：有 `pendingInput` 用它，没有就看当前模型的 `secret`。因此对话框仍显示密钥输入框时，后续消息（例如输错后重试）也按密钥处理：记住并删除；模型变成非密钥后不删。修订了既有用例中"密钥答复后第二条消息不算密钥"的期望（那是 `pendingInput` 被清空的副产物）。 |
| 59 | Telegram 发起的 `!` 命令：结果与终端输入框 | **结果总是送回这条命令自己的消息；上一条还在运行就拒绝；结束后输入框恢复成命令之前的样子**（2026-10-27，issue #17；用户确认"连发时与 TUI 一致，拒绝并提示"）。三个原因都由 E2E 复现并用追踪/宿主源码定位：(1) agent 回合进行中，两个宿主都把 bash 输出组件放进 `pendingMessagesContainer`（pi `interactive-mode.js` `isDeferred = this.session.isStreaming`；OMP `command-controller.ts` `handleBashCommand`），直到下一次提交才移进对话区；插件只监听对话区，作用域静默 1.5 秒即结束，结果永远不到 Telegram。修法：`output.ts` 在 `"!"` 作用域里也认领待发区的 bash 组件（`output-pending-add-child`），由 `hasRunningBash` 保持作用域到 `setComplete`；组件稍后被移进对话区时按 `bashTracked/bashPushed` 去重（1623a64）。(2) 上一条 bash 还在运行时宿主拒绝新的 `!` 并把文本放回输入框，而插件为新命令开的作用域替换了上一条的，导致输出串到新消息上。修法：提交前检查 `session.isBashRunning || bashSubmitInFlight`，命中就直接回复提示、不提交（37e693a）；`bashSubmitInFlight` 覆盖插件并发处理消息时"已提交但宿主约 60ms 后才置位 isBashRunning"的空窗（追踪数据，256e0c0）。(3) 插件把命令写进编辑器提交（`tui-bridge.ts` `submitToHostResult` 绕过编辑器自己的回车清空），`restoreDraft` 原先只在草稿非空时写回，草稿为空时命令文本留在输入框。修法：输入框为空或等于命令文本时一律写回草稿（含空串）；命令执行期间用户自己改了输入框则不覆盖（e35f15e）。验收：`Telegram ! commands leave the TUI input clean`（12 次 + 草稿变体）与 `Telegram ! command results under load`（回合中、连发、长输出、对话框打开、`!!`）在 OMP 和 pi 上均通过；修复前分别为 0/12 与回合中/连发失败。 |

"谁发起，谁显示"与"共享所有权"的关系：Telegram 发起的对话框由宿主画在终端里，所以终端上一定也能看到并操作（共享，先操作者生效）；但终端上的变化不会主动推到 Telegram，本地发起的对话框也不会出现在 Telegram。

---

## 10. 后续 TODO（不在本次重构范围内）

- [x] ~~清理 `off` 模式~~：v6 改为立即删除，见 §0.1 第 4 条与任务 D1–D4。

- [x] ~~E2E：`settings mirror matches the host screen`（OMP）偶发失败~~：屏幕镜像已在 D2 删除，该步骤不再存在。
- [x] ~~**运行时被替换时，队列里未发出的 Telegram 调用被静默丢弃。** `lib/active-transport.ts` 在 `isActive()` / lease 不匹配时直接返回兜底结果（`sendButtons` 返回 `message_id: 0`），调用方拿不到错误，看起来像"菜单没发出去"。2026-10-24 S5 测量时每个阶段结束的最后一秒都有几条。应改为显式失败或在新运行时补发。~~：Z1 `736e794`：`/new`、`/reload` 的结果改由新运行时发出（`lib/pending-notices.ts`）；丢弃规则本身保留（防止非活跃实例发消息）。

- [x] ~~**OMP 内置选择器剩余核对**（T3.2e/T3.2f）：`/model`、`/settings`、`/login`、`/agents`、`/hub` 已在 E2E 证实；OMP 的 `/resume`、`/tree` 以及内置对话框里的文字输入框（TSP `edit` 事件）尚未专门验证。~~：Z2 `f346ee3`（标签页、范围、动作栏、搜索）、Z4 `704c595` + Z4b `a5ab7cf`（内置文字输入框）；E2E 已覆盖 `/tree` 切换标签、有历史会话时的 `/resume`（Z6 `23cf7ab`）。
- [x] ~~**OMP 设置页的其他控件**：数字、文字、多选、快捷键类设置在 Telegram 上只显示"请在终端修改"。~~：Z3 `ec48a21` + Z3b `a8be6ba` + Z8 `f0a8b27`：数字、文字、多选、动作类均可在 Telegram 修改，设置页可搜索；快捷键类仍只在终端修改（只在终端有意义）。
- [x] ~~**插件命令与宿主同名**：`/status`、`/debug` 由插件处理，会遮住宿主的同名命令；`/tg → Config` 的 Thinking level 与宿主自己的 `/thinking` 重复。~~：`/debug` 移入 `/tg`（N1 `fd4cb1f`）；两个宿主都没有顶层 `/status`（只有 OMP 子命令），不冲突；pi 上隐藏 Config 的 Thinking level（Z5 `2dabd41`），OMP 没有 `/thinking` 命令，保留。

- [x] ~~对话框底部按钮一行超过 8 个时 Telegram 拒收~~：Z7 `c7b4da0` 每行最多 3 个，渲染出口再保证不超过 8 个；E2E 断言改为跳过被拒收的调用（Z7、Z8）。

---

## 11. 修订说明

### v6（相对 v5，2026-10-24）

用户确定：只支持 pi `1.4.0` 与 OMP `18.12.x`；识别不了的对话框明确告知；立即删除 `off` 模式、插件原生实现、旧屏幕镜像与快照方向键；E2E 用"待迁移"清单区分预期失败。新增 §0.1 与决定 46–50；决定 2、34 作废；原则 1、5 与 §4.2.5、§4.6.5 #13、§4.10、§8、§10 相应改写。文中 pi 0.81.1 的行号引用待任务 A1 核对 1.4.0 源码后更新。

### v5（相对 v4，2026-10-24）

依据 OMP 18.12.5 源码（此前误以为 OMP 只有编译后的二进制，未查源码）和三次可行性验证，OMP 一侧改为结构化通道：新增 §4.11 与决定 41–45；§4.6.6 例外二进入过渡期，T3.2g 删除；决定 18 作废。pi 一侧不变。

### v4（相对 v3）

依据第三轮评审（6 个高、6 个中、若干细节），全部经源码核实成立。pi-goal 未安装在本机，其组件字段无法核实，因此第 1 条改为"阶段 0 探测后决定"。阶段 0（2026-10-23）已完成：pi 0.81.1、OMP 18.12.5、pi-goal 0.6.0 的探测文件见 `docs/host-probe/`，结论回填到 §4.1.2、§4.1.3、§4.3、§4.4、§4.6.5、§4.6.6、§4.8 和 §6。

| 评审点 | 修改位置 |
|---|---|
| CustomGoalAdapter 违反原则 2 | §2 原则 2 指向例外；新增 §4.6.6；阶段 0 加 pi-goal 探测；§9 决定 12 |
| `isStreaming` 粗筛丢命令输出 | §4.4 去掉该条件；§9 决定 13 |
| 消息类组件字段判断错误 | §4.4 改为 `streamingComponent` + 构造器名 + `lastMessage`/`hasToolCalls`/`toolCallId` |
| 传输层脱敏漏匹配、破坏 HTML | §4.7.4 改为源头替换、8 字符下限；§5 文件清单；§9 决定 14 |
| `expect` 时机与适用范围 | §4.2.3 代码先登记后提交、内置命令不登记；§4.3；§9 决定 15 |
| 2 秒窗口错过排队 prompt | §4.3 过期条件改为状态判断 + 60 秒上限 |
| `/more`、`/pair` 不在 `pluginOnly` | §4.2.1、§4.2.2 第 0 步 |
| pi 的 `hostBuiltin` 无法推导 | §4.2.1 改为附录 A 静态列表 |
| `pluginOnly` 绕过焦点检查 | §4.2.2 第 0' 步守卫；§4.2.3 检查 `hasPendingInput`；§9 决定 16 |
| "回复其他消息也算输入"与 `resolveInput` 冲突 | §4.5.1 表格 |
| progress 无关闭语义 | §4.5 规则 7 |
| 消息复用与 turn 新发矛盾 | §4.5 规则 2、4.1；§4.7.3 按 owner 类型区分 |
| 细节 | 删除 `CommandScope.secrets`；§4.3 规则 3 措辞；owner 按 `chatId + messageThreadId` 比较；`keyMap` 保留 3 代；`entryStack` 在 `finally` 出栈；SecretStore `/new` 清空与局限说明；`/export` 包装按 scope 标签生效 |

### v3（相对 v2）

依据第二轮评审（4 个结构问题、7 个中等或细节问题），全部经源码核实成立。另外补充了评审未提到的两点：现有本地命令镜像违反决定 1；`/resume`、`/fork` 的聊天区重建会被 `addChild` 截获造成刷屏。

| 评审点 | 修改位置 |
|---|---|
| agent/工具输出会被 OutputCapture 和 renderer 双发 | §4.4 内容域划分与 `addChild` 截获条件；§9 决定 9 |
| `notify` 双发 | §4.9 第 1 条：`on` 模式下 `notify` 只转宿主 |
| Gateway 与 `runCommandHandler` 的 UI 模式矛盾；`pluginOnly` 是例外 | §0、§2 原则 1、§4.2.1、§4.2.6（`uiMode`） |
| 扩展命令没有完成信号 | §4.1.2 新增 `session.prompt` hook；§4.3 第二完成信号；§9 决定 10 |
| 实例 hook 变旧 | §4.1.1 tick 重新包装；提交 hook 改打在 `defaultEditor.onSubmit` |
| `mode.editor.editor` 不存在；`focusedComponent` 是私有字段 | §4.1.3 分类表；§4.1.2 焦点读法 |
| 本地提交抑制范围过大 | §4.2.3 只包同步调用 |
| 30 分钟上限的收尾 | §4.3 |
| InfoPanel 让 Snapshot 不可达 | §4.6.5 #12 改为白名单 |
| entry 关联窗口、confirm 嵌套 | §4.1.2 entry 关联（`WeakMap` + 栈 + 包装工厂） |
| 密钥作用域与脱敏范围 | §4.7.4 `SecretStore` + transport 层脱敏 |
| 对话框替换时的摘要优先级 | §4.5 规则 4 |
| settings cycle 计算 | §4.6.5 #5 |
| `findShape` 跳过 `editor` | §4.6.3 |
| ExtensionEditor 提交键 | §4.6.5 #3（已确认 Enter） |
| `hideOverlay` 路径措辞 | §4.1.3 |
| `registerExternalInput` 细节 | §4.5.1 |
| （补充）本地命令镜像 | §4.9 第 5 条；§9 决定 11 |
| （补充）聊天区重建刷屏 | §4.1.2 `chatContainer.clear` hook；§4.4 |

### v2（相对 v1）

依据一次针对 pi 0.81.1 源码和插件代码的评审，全部 14 条意见经核实成立（"OMP 未安装"一条除外：OMP 安装在 `~/.local/bin/omp`，但为编译后的二进制，确实无法直接复核，因此新增阶段 0）。主要修改：

| 评审点 | 修改位置 |
|---|---|
| `onSubmit` 只对部分命令挂起 | §4.2.3 列出 await 型与立即返回型；草稿恢复移到 scope 结束（§4.2.4）；scope 结束条件重写（§4.3） |
| SettingsList 子菜单不调 `setFocus` | §4.6.5 #5：子菜单为同一会话内的嵌套状态；`ThemeSubmenu` 降级 |
| 字段位置、焦点对象 | §4.1.3 会话身份以焦点对象为准；§4.6.3 新增 `findShape`；附录 B 修正 |
| 焦点 ≠ 对话框；非捕获浮层；`setFocusInternal` | §4.1.3 焦点分类、焦点校验；非捕获浮层列为非目标 |
| scope 过早结束丢输出 | §4.3 |
| `/fork` 写编辑器 | §4.2.4 |
| enqueued turn 归属 | §4.2.6、§4.3 规则 2 |
| 文本输入路由、密钥来源 | §4.5.1、§4.7.4、`LoginDialogAdapter` |
| 快照回调串台 | §4.7.1 快照统一用 `tgplus:dlg:` |
| 多问题问卷、approve | `questionnaire`、`approval` 模型；适配器 #4、#10 |
| 插件命令优先级、`/debug` 重名 | §4.2.1、§4.2.2 |
| 缺省值迁移、配置矛盾 | §4.10；§8 删除"可配置禁用密钥" |
| 阶段 1 事后判定 | 阶段 1 改为静态白名单；新 hook 在阶段 1 只观察 |
| 零碎项 | 文档头改为"取代原则 1"；`/export` 改为取宿主方法返回值；`tui-bridge.ts` 统一为"阶段 5 删除"；插件代码引用改为函数名 |

---

## 附录 A：pi 内置命令分类（0.81.1，`setupEditorSubmitHandler` L2085-2218）

| 类别 | 命令 | `onSubmit` 行为 |
|---|---|---|
| 打开对话框 | `/settings`、`/fork`、`/tree`、`/trust`、`/logout`、`/resume` | 立即返回 |
| 打开对话框 | `/scoped-models`、`/login`、`/model`（无参数，或参数无精确匹配） | await |
| 只有输出 | `/name`、`/session`、`/changelog`、`/debug`、彩蛋命令 | 立即返回 |
| 只有输出 | `/export`、`/share`、`/compact`、`/model <精确名>` | await |
| 宿主控制（原生处理器） | `/reload`、`/fork`、`/clone`、`/import` | await 或立即返回；**不提交编辑器**（§9 决定 21） |
| 宿主控制（会话替换） | `/new` | 走 `ctx.newSession()`，不提交编辑器（§9 决定 22） |
| 终端专属（§4.8） | `/copy`、`/hotkeys`、`/quit` | — |
| 前缀 | `!`/`!!` | 保留现有 `runTelegramBash` |

`/model <词>`：`handleModelCommand`（L3586）精确匹配到模型时直接切换并 `showStatus`，否则打开带搜索词的选择器。

扩展命令、提示词模板、技能不在这个 `if` 链中，会落到后面的通用提交逻辑（压缩中 L2236、流式中 L2248、空闲时 `onInputCallback` L2262），同样适用 Gateway 的"直接提交"。

阶段 1 的白名单取"只有输出"两行中可提交且不替换运行时的命令：`/name`、`/session`、`/changelog`、`/debug`、`/export`、`/share`、`/compact` 和彩蛋命令；`/new` 走 `ctx.newSession()`；`/reload`、`/fork`、`/clone`、`/import` 保留原生处理器。OMP 的命令在阶段 3 接入。

## 附录 B：pi 对话框组件结构（0.81.1）

| 对话框 | 焦点对象 | 数据所在 |
|---|---|---|
| 扩展 select/confirm | `ExtensionSelectorComponent` | 自身：`options`、`selectedIndex`、`onSelectCallback` |
| 扩展 input | `ExtensionInputComponent` | 自身：`input`（Input）、`onSubmitCallback` |
| `/settings` | `selector.getSettingsList()`（SettingsList） | SettingsList 自身：`items`、`filteredItems`、`selectedIndex`、`onChange`；打开子菜单时为 `submenuComponent`（子菜单类内部多为 SelectList，`ThemeSubmenu` 例外）。`SettingsSelectorComponent` 只持有一个主 `settingsList` |
| theme / thinking / show-images | 各自组件 | 内部 `SelectList`：`items`、`filteredItems`、`selectedIndex`、`setSelectedIndex()`、`getSelectedItem()` |
| `/model` | `ModelSelectorComponent` | 自身：`filteredModels`、`selectedIndex`、`currentModel`、`searchInput`、`scope` |
| `/logout`、`/login` 服务商 | `OAuthSelectorComponent` | 自身：`filteredProviders`、`selectedIndex`、`searchInput` |
| `/resume` | `SessionSelectorComponent` | 字段 `sessionList`（普通类 `SessionList`，不是组件）：`filteredSessions`、`selectedIndex`、`searchInput`、`sortMode`、`nameFilter` |
| `/fork` | `selector.getMessageList()` | 消息列表对象（实现时确认字段） |
| `/login` 输入 | `LoginDialogComponent` | `Input`；提交后输入框被替换为 `> value` 文本 |
| `/share` 等 | `BorderedLoader` | 进度，不是对话框 |
| `/reload` | `reloadBox`（Box） | 无 `handleInput`，忽略 |
| `/tree`、`/scoped-models`、`/trust`、config | 各自组件 | 实现时用 `findShape` 确认 |

结论：pi-tui 的基础控件（`SelectList` / `SettingsList`）只覆盖设置类对话框；模型、会话、登录等高频选择器是自绘列表，大多遵循"`filtered*` 数组 + `selectedIndex` + 选中回调"的约定，但数据可能在非组件的嵌套对象上，由 `findShape` + 通用 `FilteredListAdapter` 处理，再按需补专用适配器。
