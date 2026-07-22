# pi-telegram-plus 0.0.5 发布前检查清单

检查时间：2026-07-22

## 建议版本

- 发布版本：`0.0.5`
- 当前源码 `package.json` 已 bump 到 `0.0.5`。
- 本清单不包含、也未执行 `npm publish`。

## 已完成的 0.0.5 必修修复

1. **polling offset 消息丢失**
   - 文件：`lib/polling.ts`
   - 修复：新增 `processTelegramUpdatesBatch()`，同一批 update 中只要某条 update 处理失败或 offset 持久化失败，就立即停止本批处理，不再继续处理后面的 update，也不会把 `lastUpdateId` 推过失败 update。
   - 测试：`lib/__tests__/polling.test.ts`

2. **回复/工具输出/状态通知串到其他聊天或 topic**
   - 文件：`index.ts`、`lib/controller.ts`、`lib/renderer.ts`、`lib/attachments.ts`、`lib/telegram-ui.ts`、`lib/telegram-api.ts`、`lib/heartbeat.ts`、`lib/commands/info.ts`、`lib/turn-context.ts`
   - 修复：使用 `AsyncLocalStorage` 明确记录当前 Telegram turn；`TelegramTurn` 记录 `chatId`、`messageThreadId`、`sourceMessageId`；active turn、pending input、UI notify、renderer、`tg_attach`、typing heartbeat、`/status` direct send 都按 chat/thread/source message 路由；Telegram API sendMessage/sendButtons/sendDocument/sendPhoto/sendChatAction 会携带 `message_thread_id`，sendMessage/sendButtons 同时携带 `reply_parameters`；生产代码已移除“没有上下文时取唯一 active turn”的兜底；heartbeat 的 typing 二次确认使用 chat/thread key，避免同 chat 其他 topic 保留时向已结束 topic 误发。
   - 测试：`lib/__tests__/renderer-routing.test.ts`、`lib/__tests__/controller-thread-routing.test.ts`、`lib/__tests__/controller-ui-routing.test.ts`、`lib/__tests__/telegram-api.test.ts`、`lib/__tests__/attachments.test.ts`、`lib/__tests__/info-status.test.ts`、`lib/__tests__/heartbeat.test.ts`

3. **Telegram UI 与本地 TUI/其他 Telegram 命令的 UI 抢占**
   - 文件：`lib/controller.ts`
   - 修复：用可嵌套 routed UI proxy 替代简单全局替换。Telegram turn 上下文内走 Telegram UI；本地或无 Telegram turn 上下文走原 TUI；重叠 Telegram 命令按各自 chat/thread/source message 路由，proxy 匹配完整 Telegram turn 目标而不是只比 chatId。
   - 测试：`lib/__tests__/controller-ui-routing.test.ts`、`lib/__tests__/controller.test.ts`

4. **附件敏感路径软链接绕过和前缀误判**
   - 文件：`lib/attachments.ts`
   - 修复：发送前对路径做 `realpath()`，敏感根目录使用 canonical path，并用路径边界判断，避免 `/etc2`、`.ssh2` 这类误判。
   - 测试：`lib/__tests__/attachments.test.ts`

5. **首次发消息自动成为管理员**
   - 文件：`lib/pairing.ts`、`index.ts`、`lib/commands/telegram-commands.ts`、`lib/types.ts`、`README.md`
   - 修复：设置或绑定 bot token 时生成一次性配对码；Telegram 用户必须发送 `/pair <code>` 才会持久化为 `allowedUserId`；任意第一位用户普通发消息不会再自动绑定。
   - 测试：`lib/__tests__/pairing.test.ts`

6. **Pi 兼容声明过宽**
   - 文件：`package.json`、`README.md`
   - 修复：peer dependency 从 `*` 收紧为 `@earendil-works/pi-coding-agent >=0.76.0 <0.82.0`；README 明确 Node 要求、验证矩阵、`0.74.x` 不支持、未来 Pi minor 未验证。

7. **临时多 Pi 版本验证脚本**
   - 文件：`scripts/test-pi-versions.mjs`、`package.json`
   - 修复：新增 `npm run test:pi-versions`，在临时目录复制当前工作区，安装指定 Pi 版本和测试依赖，运行 `npm run typecheck` 与 `npm test`，最后清理临时目录。

8. **Telegram 引用消息上下文丢失**
   - 文件：`lib/controller.ts`、`lib/types.ts`、`README.md`
   - 修复：当 Telegram 入站消息包含 `reply_to_message` 时，把被引用消息的 `message_id`、sender、text/caption 和附件摘要作为 `[telegram quoted message]` 前置到 agent prompt；如果 Telegram 只提供 reply message id，则仍把 id 和 `content: unavailable from Telegram update` 交给 agent；回复 active UI input/editor/custom prompt 时仍优先作为 UI 输入消费；引用附件只做摘要，不重复下载。
   - 测试：`lib/__tests__/controller.test.ts`

## 已运行验证

### 当前工作区

```text
npm run typecheck
# passed

npm test
# 20 test files passed
# 252 tests passed
```

### 临时多 Pi 版本矩阵

命令：

```text
npm run test:pi-versions
```

结果：

| Pi 版本 | typecheck | tests |
|---|---:|---:|
| `0.76.0` | passed | 20 files / 252 tests passed |
| `0.78.0` | passed | 20 files / 252 tests passed |
| `0.80.7` | passed | 20 files / 252 tests passed |
| `0.80.10` | passed | 20 files / 252 tests passed |
| `0.81.1` | passed | 20 files / 252 tests passed |

### 真实 Telegram E2E 冒烟验收（pi 0.81.1）

环境：`/private/tmp/pi811-workspace.xUVITe` 临时 pi `0.81.1`，隔离全局扩展后加载当前工作区的 `pi-telegram-plus` 运行时副本。

结果：passed。

覆盖项：

- `/status`：正确返回 workspace、session、model、thinking、context/token、message 统计。
- `/debug`：正确返回 model、thinking、streaming/compacting、entries、cwd。
- 普通 Telegram prompt：能进入当前 pi agent 会话并返回回答。
- `read` 工具：成功读取 `/private/tmp/pi811-workspace.xUVITe/package.json` 并在 Telegram 渲染工具调用。
- `tg_attach`：成功把 `/private/tmp/pi811-workspace.xUVITe/package.json` 作为 Telegram 附件发送。
- Telegram 入站附件：图片 `2.jpg` 成功保存到 `/private/tmp/pi811-workspace.xUVITe/...jpg`，本地确认为 JPEG 文件。
- `bash` 长任务 + `/stop`：运行中的 bash 工具收到 abort，Telegram 侧显示 `Request was aborted`。
- `/tg-config`：一级 inline keyboard 正常渲染；点击 `Tool rendering` 后二级 callback 正常，成功设置为 `full`。

### 代码和打包检查

```text
git diff --check
# passed

npm pack --dry-run --json
# passed; package includes README.md, index.ts, lib/**/*.ts, pi-host.d.ts
# package excludes tests, .pi-subagents, node_modules, temporary matrix directories
```

## 发布前注意事项

- `package.json` 已 bump 到 `0.0.5`。
- bump 后已重新运行：
  - `npm run typecheck`
  - `npm test`
  - `npm run test:pi-versions`
  - `git diff --check`
  - `npm pack --dry-run --json`
- 确认 npm tarball 版本显示为 `pi-telegram-plus@0.0.5` 后再发布。
- 不要把 `.pi-subagents/`、`.pi/`、`node_modules/`、临时矩阵目录或真实 Telegram token 放进提交。

## 仍保留的非阻断风险

- 本次已在 pi `0.81.1` 上完成真实 Telegram bot 冒烟验收；但仍不是长跑压测，Telegram 网络错误、429 限速、多用户/多 topic 长时间并发仍建议后续继续观察。
- 插件仍依赖 Pi 的部分内部/半内部能力，例如 UI context 切换、extension runner 行为和 session capture；当前矩阵通过 `>=0.76.0 <0.82.0`，未来 Pi minor 需要重新验证。
- `package-lock.json` 当前被 `.gitignore` 忽略；如果后续希望 CI 使用 `npm ci`，需要另行决定是否提交 lockfile 或改 CI 安装策略。
