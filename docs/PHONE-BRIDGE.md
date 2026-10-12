# 手机远控（phone bridge）

让**手机在任意网络**下发一条飞书消息，主机上的 DSH 就把它当成一次 PDF 处理任务执行，并把**产物回传到你手机**。

```
手机（4G/5G/别处 Wi-Fi，任意网络）
  │ ① 你发一条：/pdf 给 报告.pdf 加上页码，输出到 outbox
  ▼
飞书服务器
  │ ② 主机上的桥接器轮询（默认 5s）
  ▼
scripts/phone-bridge/main.mjs
  │ ③ 过滤（白名单 / 前缀 / 时效）→ 单飞队列 → 执行
  │    dsh --profile headless "<提示词>"      ← agent 只允许调用 pdf_* 工具
  │ ④ 产物写到 outbox/<taskId>/
  ▼
lark-cli 回传：一条文本回执 + 每个产物文件
手机 ◀── 你在飞书里直接看到结果与 PDF
```

为什么用飞书而不是"手机直连主机"：**双方都主动出网**，所以主机在 NAT 后面、手机在蜂窝网络、相隔多远都不用开端口、也不用公网 IP。想更快（局域网速度、不受 IM 大小限制）可以再叠一层 Tailscale，见文末。

---

## 1. 前置条件

| 项 | 说明 |
|---|---|
| `lark-cli` | 已配置应用（`lark-cli config init`）并完成用户授权：<br>`lark-cli auth login --scope "im:message:readonly im:message"` |
| 应用权限（scope） | 读消息 `im:message:readonly`；发消息 `im:message`（用 bot 身份发还需要 `im:message:send_as_bot`，并把机器人**拉进目标会话**） |
| `dsh` | 在 PATH 里可执行；`dsh --profile headless "<任务>"` 能跑一轮任务 |
| Node | 与插件一致（本项目用 Node 26 + `--experimental-strip-types`） |

> 桥接器本身**不装任何依赖**：只用 `node:child_process` 调 `lark-cli` 与 `dsh`。

## 2. 飞书侧准备（拿到两个 id）

> **群里怎么发指令**：飞书的机器人在**群聊里默认只收到 @它 的消息**（要收全部群消息需要额外权限并审批）。
> 所以在群里请 **@机器人** 再写指令：`@PDF 远控 /pdf 给 报告.pdf 加页码`。
> 桥接器会**自动剥掉开头的 @提及**再识别 `/pdf` 前缀；不想 @ 就改用**与机器人的单聊**（单聊消息一定送达）。


```sh
# ① 找一个会话（群或与机器人的单聊）：拿 chat_id（oc_...）
lark-cli im +chat-search --query "关键词" --format json

# ② 拿你自己的 open_id（白名单用）——配置里已有你的身份时会直接显示
lark-cli config show

# ③ 确认能读到该会话的消息（权限没配好会在这一步报错）
lark-cli im +chat-messages-list --chat-id oc_xxx --page-size 5 --format json
```

## 3. 配置

复制模板（`scripts/phone-bridge.config.example.json`）成你自己的配置，建议放到**仓库外**（避免误提交）：

```json
{
  "chatId": "oc_你的会话",
  "allowedSenderIds": ["ou_你自己的open_id"],
  "allowedSenderNames": ["你的名字"],
  "prefix": "/pdf",
  "outboxDir": "/Users/你/Desktop/pdf-outbox",
  "dshPath": "dsh",
  "profile": "headless",
  "identity": "bot",
  "larkCliPath": "lark-cli",
  "pollMs": 5000,
  "timeoutMs": 300000,
  "maxInstructionChars": 2000,
  "maxAgeMs": 1800000,
  "allowedExtensions": [".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md"],
  "maxFileBytes": 31457280,
  "maxFilesPerTask": 5,
  "statePath": "phone-bridge-state.json",
  "logPath": "phone-bridge.log"
}
```

| 字段 | 作用与默认值 |
|---|---|
| `chatId` | **必填**。监听哪个会话（`oc_...`）。 |
| `allowedSenderIds` / `allowedSenderNames` | **至少要有一个非空**（两者都空 → 配置非法、直接起不来）。这是"只有我能指挥这台机器"的唯一凭据。 |
| `source` | `poll`（默认，轮询消息列表）或 `event`（`lark-cli event consume` 长连接，更即时）。见 §4.2。 |
| `eventKey` | `source=event` 时消费的事件，默认 `im.message.receive_v1`。 |
| `prefix` | 指令前缀，默认 `/pdf`。**只有带前缀的消息才会被执行**，平时在群里聊天不会误触发。 |
| `outboxDir` | **必填**。产物目录；提示词里要求 agent 只能写到这里，回传也从这里取。 |
| `dshPath` / `profile` | 触发命令：`<dshPath> --profile <profile> "<提示词>"`，默认 `dsh` / `headless`。 |
| `dshArgs` | 追加给 `dsh` 的参数（放在 `--profile <p>` 之后、任务正文之前）。**最常用的是 `--patch`**——见下面 4.1，headless 默认不带 pdf-studio 插件。 |
| `identity` | `bot`（默认）或 `user`。用 `user` 时需要上面的 user 授权；`bot` 需要机器人已在会话里。 |
| `pollMs` | 轮询间隔，默认 5000ms。 |
| `timeoutMs` | 单任务超时，默认 300000ms（5 分钟）；超时会杀掉任务并回一条"超时"回执。 |
| `maxAgeMs` | 只执行"不早于 now − maxAgeMs"的消息，默认 30 分钟（主机离线一夜后**不会**把旧指令全补跑）。 |
| `maxInstructionChars` | 指令长度上限，默认 2000 字。 |
| `allowedExtensions` / `maxFileBytes` / `maxFilesPerTask` | 回传白名单：扩展名、单文件字节上限（默认 30MB）、每任务最多几个文件（默认 5）。 |
| `readIdentity` | **读消息**用哪个身份，默认与 `identity` 相同。**读群里的全部消息（含文件）只能用 `user`**（应用需有 `im:message.group_msg:get_as_user`），而发消息仍用 `bot` 才像"机器人发给你"——所以推荐 `identity: "bot"` + `readIdentity: "user"`。 |
| `allowedChatIds` | 除 `chatId` 外**额外接受**的会话（默认空）。**发文件必须靠它**——把与机器人的单聊 id 填进来。 |
| `inboxDir` | 附件下载目录，默认 `<outboxDir>/inbox`。 |
| `inputTtlMs` | 待处理附件有效期，默认 30 分钟；过期不再塞进任务（避免旧文件混进新任务）。 |
| `maxInputBytes` | 单个附件大小上限，默认 30MB；超了拒绝并回执。 |
| `autoConfirm` | 是否让 agent **自行走完插件的确认单**，默认 `true`。**只有"会覆盖/改写源文件"的确认单才停下来问**；「在产物里去掉内容」（删水印/删某页/删某段文字）直接做完——插件的写操作一律另存新文件、不动源文件（早先把这类也算"删除内容"，结果助手停下来反问，而用户其实早已下令 ✗）。手机端没法逐步点「确认」，不开这个任务会停在确认单上、**什么都没产出**（实测踩过）；开了仍保留红线：**删除类/覆写类**确认单必须停下来汇报。设 `false` 则一律停下等用户确认。 |
| `maxQueueLength` | **背压**：队列上限，默认 3（0 = 不限）。满了会**明确回执「先没收」**，队列空了自动恢复——比静默堆 20 个任务好。 |
| `outboxRetentionDays` | outbox 任务目录保留天数，默认 14（0 = 不清理）。只清**桥接器自己命名的**目录（`t-<时间戳>-<尾号>`），跳过正在跑的任务；`--dry-run` 下只报告不删。 |
| `statePath` / `logPath` | 去重账本与日志（相对路径按**配置文件所在目录**解析）。 |

## 4. 运行

```sh
# 不联网自检（用假消息/假 dsh 跑完整流水线）
npm run phone-bridge:selftest

# 只打印"将会执行什么"，不跑 dsh、不发消息（第一次务必先跑这个）
npm run phone-bridge -- --config ~/pb.config.json --dry-run

# 跑一轮就退出（launchd / cron 友好）
npm run phone-bridge -- --config ~/pb.config.json --once

# 常驻
npm run phone-bridge -- --config ~/pb.config.json
```

> 第一次联调建议顺序：`--dry-run` 看到自己的消息被正确解析 → 再去掉 `--dry-run` 用 `--once` 跑一次（确认 dsh headless 能产生产物）→ 最后常驻。

#### 4.0 先跑一次「上线自检」（强烈建议）

```sh
npm run phone-bridge:preflight -- --config ~/pb.config.json
```

它会逐项检查并给出**可直接照做的修复命令**：

| 检查项 | 说明 |
|---|---|
| `lark-cli` 可用 | 打印 appId 与授权到期时间（**不打印密钥**） |
| 用户授权未过期 | 过期时提示 `lark-cli auth login --scope "im:message:readonly im:message"` |
| 能读取目标会话 | 最能暴露 `chat_id` 写错 / 机器人不在会话 / 缺 `im:message:readonly` |
| 发送参数可用 | **用 `--dry-run`**，不会真的发出消息 |
| `dsh` 与 `--profile <p>` 可用 | 只打印 usage 验证存在性，**不跑任务**；失败时指向 §4.1（插件叠加） |
| `outbox` 目录可写 | 不存在会尝试创建 |
| 事件模式前置 | `source=event` 时提醒飞书侧需配事件订阅（本地无法判定） |

全部通过 → 退出码 0；有失败项 → 退出码 1（可以直接接进脚本/CI）。

### 开机常驻（launchd）

`~/Library/LaunchAgents/com.local.pdf-phone-bridge.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.pdf-phone-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/你/.nvm/versions/node/v26.1.0/bin/node</string>
    <string>--experimental-strip-types</string>
    <string>/Users/你/Desktop/deaktop-tool/pdf-studio/scripts/phone-bridge/main.mjs</string>
    <string>--config</string>
    <string>/Users/你/pb.config.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/你/pb.out.log</string>
  <key>StandardErrorPath</key><string>/Users/你/pb.err.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.local.pdf-phone-bridge.plist     # 启用
launchctl unload ~/Library/LaunchAgents/com.local.pdf-phone-bridge.plist   # 停用
```

注意：`node` 与配置都写**绝对路径**（launchd 的 PATH 很干净）；`KeepAlive` 会在崩溃后自动拉起。

### 4.1 让 headless 能用上 pdf-studio 插件（**很重要**，已实测）

插件是**按 profile 安装**的：本机 `desktop` profile 装了 `dsh-pdf-studio`
（`package.json` 里 `dsh.profile.bundles` 列了它、`dependencies` 是 `link:` 到插件目录）。
`headless` 是另一个 profile，**默认没有它**。

> **实测结论（我踩过）**：`dshArgs: ["--patch", "…/desktop/cordis.patch.yml"]` **不管用**——
> `--patch` 只叠加"配置层"，**不带来插件依赖**；agent 会如实报 `unknown tool "pdf_text"`。

**正确做法：把插件装进 headless profile**（本机已执行并验证通过）：

```sh
cd ~/.dsh/profiles/headless && cp package.json "package.json.bak-$(date +%s)"   # 备份便于回退
# 编辑 ~/.dsh/profiles/headless/package.json：
#   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-pdf-studio"] } },
#   "dependencies": { "dsh-pdf-studio": "link:/Users/你/Desktop/deaktop-tool/pdf-studio" }
dsh plugin --profile headless install          # link 本地目录，不需要联网
```

装好后 `~/.dsh/profiles/headless/node_modules/dsh-pdf-studio` 是指向插件目录的软链。
**验证**：跑一条真实任务，能产出文件即成功（例如让 headless 给 `/tmp/pb-test.pdf` 加页码）。
**回退**：`dsh plugin --profile headless remove dsh-pdf-studio`，或还原 `package.json.bak-*`。

> `dshArgs` 仍可用于临时叠加别的配置层，但**不要指望它带插件**。

### 4.3 手机发文件过来让它改（两段式）

> ⚠️ **群机器人只收到 @它 的消息，而文件消息带不了 @** —— 所以"在群里直接发文件"机器人**收不到**（实测 `event status` 的 RECEIVED 一直是 0）。
>
> **两条可行路径**（按推荐顺序）：
>
> **① 轮询 + user 身份读群消息（推荐，群里照常用、还不用 @）**
> 应用已有 `im:message.group_msg:get_as_user`（以用户身份读群消息），所以只要用户授权一次：
> ```sh
> lark-cli auth login --scope "im:message:readonly im:message im:message.group_msg:get_as_user"
> ```
> 然后桥接器配置成：
> ```json
> { "source": "poll", "identity": "bot", "readIdentity": "user" }
> ```
> 读消息用你的身份（能看到群里的**全部**消息，含文件），发消息仍用机器人。
> 附带好处：**用户在群里连 @ 都不用**（轮询不依赖 @）。
>
> **② 与机器人的单聊**：如果应用额外开通了单聊读取权限（`im:message.p2p_msg:readonly`），单聊也能用；
> 但本机实测该 scope **未开通**（单聊发消息 `RECEIVED` 仍是 0），所以要走这条路得先去开发者后台加权限。
>
> 下面是单聊路径的说明（前提是权限齐备）：

> ⚠️ **发文件必须用「与机器人的单聊」**：群里的机器人**只收到 @它 的消息**，而**文件消息没法带 @**——
> 所以在群里单独发文件，机器人**根本收不到**（实测：`event status` 的 RECEIVED 一直是 0）。
> 单聊消息一定送达，所以文件走单聊。
>
> 把单聊的 chat_id 填进 `allowedChatIds`，两个会话就都能下指令：
> ```json
> { "chatId": "oc_群id", "allowedChatIds": ["oc_单聊id"] }
> ```
> 不知道单聊 chat_id？在单聊里随便发一条消息，桥接器日志会打
> `忽略消息：不在目标会话（oc_…）`——那串就是它。

**用法**：先在**单聊**里**把文件发给机器人**，它会下载并回一条"已收到"，你再发一条 `/pdf` 指令，产物照常回传。

```
你：（发一个 报告.pdf）
机器人：📎 已收到：报告.pdf
        请回复一条 /pdf 开头的指令告诉我怎么改（30 分钟内有效），例如：
          /pdf 给这份文件的第 1 页居中加页码
你：@机器人 /pdf 给这份文件的第 1 页居中加页码
机器人：✅ 完成（xx.xs） … + 产物文件
```

**实现路径**（踩过的点都记在这）：

| 步骤 | 命令 / 说明 |
|---|---|
| 事件里拿不到附件 key | 飞书事件对文件/图片消息只给**预渲染文本**（`content` = 文件名），所以要先按 `message_id` 取原始消息 |
| 取原始消息 | `lark-cli im +messages-mget --message-ids om_xxx` → `content` 形如 `<file key="file_v3_…" name="报告.pdf"/>` |
| 下载 | `lark-cli im +messages-resources-download --message-id … --file-key … --type file --output <相对路径>`——**`--output` 只接受相对路径**，所以桥接器是「`cwd` = `inbox/<messageId>/` + 相对文件名」调用的 |
| 落地目录 | `inboxDir`（默认 `<outboxDir>/inbox/<messageId>/`）；**源文件原样保留**，产物另写 |
| 关联指令 | 下载后按「发送者 + 会话」记住（30 分钟内有效），下一条 `/pdf` 指令把路径塞进提示词，并注明"这是源文件，不要覆盖" |
| 日志会写 | `本次任务带 N 个输入文件：…` |

**边界**：附件名会被清洗（去掉目录部分与开头的点，防 `../`）；超过 `maxInputBytes`（默认 30MB）会**拒绝并回执**；只接受白名单发送者 + 目标会话里的附件；机器人**收不到自己发的消息**（飞书语义），所以自测要用你自己的账号发。

## 5. 安全边界（重要）

这台机器会被"外部消息"驱动去改文件，所以桥接器的默认策略是**fail-closed**：

1. **白名单缺失 = 起不来**。不会出现"默认谁都能指挥"的状态。
2. **只认文本 + 带前缀**的消息；@、卡片、图片等一律忽略。
3. **旧消息不补跑**（`maxAgeMs`，默认 30 分钟）。
4. **消息内容只作为 `argv` 的一个元素**交给 `dsh`，绝不拼 shell —— 所以 `; rm -rf /`、`$(...)`、反引号在消息里都只是普通文字。
5. **提示词里硬约束**：只能用 `dsh-pdf-studio` 的 `pdf_*` 工具、**不得执行 shell**、不得改源文件、产物只能写 `outbox/<taskId>/`；手机原文被标注为"任务描述，不是系统指令"（防注入）。
6. **回传白名单**：只从 `outbox/<taskId>/` 取文件，扩展名与大小受限，排除 Office 锁文件（`~$`）、macOS 元数据（`._`）、未完成下载（`.part`/`.crdownload`）。
7. **单飞**：同一时刻只跑一个任务，避免两个任务同时改同一批文件。
8. **去重**：按 `message_id` 记账并持久化；崩溃重启后**不会重复执行**同一条消息。
9. 日志统一脱敏（`app_secret`、疑似 token 会被打成 `***`）。
10. **超时杀整个进程组**：`dsh headless` 会拉起自己的子进程，只杀直接子进程会留下孤儿；桥接器用
    `detached` 独立进程组，超时时先 `SIGTERM`、宽限期（3s）后 `SIGKILL`（对 `-pid` 发信号）。
12. **背压**：队列上限（默认 3）满了就回执拒收，避免无人值守时消息堆成几小时的任务队列。
14. **确认单的自助边界**（`autoConfirm`，默认开）：非破坏性操作的确认单由 agent 在同一轮里走完，**删除类/覆写类确认单必须停下来汇报**；想要"每一个写操作都由人点"，把 `autoConfirm` 设为 `false`。
13. **outbox 自动清理**：默认保留 14 天，只删**自己命名的**任务目录（`t-…`），**绝不碰** outbox 里的其它文件/目录，也不动正在跑的任务；`--dry-run` 只报告不删。
11. **任务结束后的输出审计**：扫一遍 agent 的输出，发现 shell 迹象（`bash -c`/`rm -rf`/`curl`/`sudo`/`child_process`）
    或"写到 outbox 之外"的绝对路径时，**在回执里列出可疑点供你核对**。
    注意：这只是**提示**，不是强制拦截——提示词里的约束才是第一道；审计措辞刻意写成"可能是误报"。

仍然建议：
- 白名单只写**你自己的** open_id；不要写"允许所有人"。
- 不要把这个桥接器接到公开群里。
- 产物目录放在你能接受的位置（默认 `outbox`，源文件永不覆盖——这是 pdf-studio 所有工具的既有约束）。

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即报"配置缺少 chatId / 白名单 / outboxDir" | 配置不完整（这是**故意**的 fail-closed） | 按报错补齐字段 |
| 消息被"忽略消息：发送者不在白名单" | open_id / 名字与配置不一致 | `lark-cli config show` 确认自己的 open_id；或临时用 `allowedSenderNames` |
| "忽略消息：没有以 /pdf 开头" | 前缀不对 | 消息写成 `/pdf 你的要求…` |
| "轮询失败：拉取消息失败" | 权限或 `chat-id` 不对 / token 过期 | `lark-cli auth login --scope "im:message:readonly im:message"`；核对 chat_id |
| "发送文件失败：…" | 机器人不在会话里、或文件超过飞书限制 | 把机器人拉进会话；或调小 `maxFileBytes` |
| 回执说"没有可回传的产物" | agent 停在确认单上，或把文件写到别处了 | 看 `outbox/<taskId>/agent-output.log`（**agent 完整输出已留档**，`.log` 不会回传给你）；确认 `autoConfirm` 是否为 `true` |
| 一直"超时" | 单任务确实很久（OCR/大文档） | 调大 `timeoutMs`，或把任务拆小 |
| 群里发文件机器人没反应 | 群机器人只收 @它 的消息，文件消息带不了 @ | **改用与机器人的单聊发文件**，并把该单聊 id 填进 `allowedChatIds`（见 §4.3） |
| 发了文件但机器人没反应 | 用的是**机器人自己发的**消息（飞书不给机器人回推自己的消息），或文件在别的会话 | 用你自己的账号在目标会话里发 |
| agent 说"没有 pdf_* 工具" | headless 没加载到插件层 | 按上面 4.1 用 `dshArgs` 加 `--patch`（或给 headless 建 profile） |
| 事件模式"就绪前退出" | 飞书侧没配事件订阅 / 权限不足 | 看日志里的 `[event] …` 行；按 §4.2 的前置条件配置，或先用 `source: poll` |
| 重启后报 `subscription already exists` | 上次被 `kill -9` 了，服务端订阅没退 | 用 `lark-cli event stop --all` 清理，然后正常 SIGTERM 退出 |
| 收不到任何回执 | 主机睡眠 / 桥接器没在跑 | 检查 `launchctl list | grep phone-bridge`、日志 `pb.err.log` |

## 7. 可选：Tailscale 直下（已实现）

飞书回传受 IM 的文件大小与频率限制；想让手机**以局域网速度直接下载产物**，可以开"直下"端点：

**① 插件侧**：给它一个令牌（长度 ≥ 16，太短会被拒绝并告警、**不注册**该路由）：

```jsonc
// 插件配置（profile 里那份）
{
  "downloadToken": "换成你自己的长随机串至少16位",
  "downloadRoot": "/Users/你/Desktop/pdf-outbox"   // 允许被下载的根目录，默认 <workspaceRoot>/pdf-outbox
}
```

于是多了一个端点：

```
GET /api/pdf-studio/download?path=<绝对路径>&token=<令牌>
```

**② DSH 侧**：让 web 服务在 Tailscale 地址上可达，并把它加进 `/api` 的信任白名单：

```sh
dsh web --host 0.0.0.0 --trusted-host <你的机器名>.<tailnet>.ts.net:19387
```

**③ 桥接器侧**（可选）：配置里填上基址与同一令牌，回执消息里就会**自动附上可点的下载链接**：

```json
{ "downloadBaseUrl": "http://<tailscale-ip 或 MagicDNS 名>:19387", "downloadToken": "与插件同一个令牌" }
```

**安全边界**（这条路由是唯一不走 loopback 栅栏的，凭据是令牌）：

| 规则 | 行为 |
|---|---|
| 没配 token | 路由**根本不注册**（默认关闭） |
| token 太短（<16） | 拒绝注册并告警，而不是用弱令牌把端点暴露出去 |
| token 不对/长度不符 | 403（定时安全比较，不泄露更多信息） |
| 路径越出 `downloadRoot`（含 `..`、同前缀兄弟目录） | 403 |
| 目录而不是文件 | 404（不列目录） |
| 文件超过 `maxBytes`（默认 64MB） | 413 |
| 非 GET | 405 |

> 仍然建议：只经 **Tailscale** 暴露（不要裸公网）；令牌用随机长串；产物目录就是 `outbox`，
> 源文件永远不会被这条路由读到（它只读 `downloadRoot` 内的文件）。

## 8. 自检与测试

```sh
npm run phone-bridge:selftest   # 不联网：假消息 + 假 dsh，验证"过滤→执行→扫描产物→回传→记账"
npm run test:phone-bridge       # 86 条纯逻辑断言（白名单/时效/前缀/去重/产物筛选/单飞队列/脱敏）
npm run test:phone-bridge-io    # 66 条接线断言（配置解析/目录扫描/**不开 shell 的安全回归**/lark argv/轮询编排/直下链接）
npm run test:download-route     # 20 条下载端点断言（默认关闭/token/越界/大小上限/非 loopback 可达）
npm run test:phone-bridge-main  # 11 条入口端到端断言（假 lark-cli + 假 dsh **真跑 main()**：事件/轮询、回传、记账、去重）
npm run test:phone-bridge-event # 26 条事件模式断言（三种负载形状/stdin 契约/ready 门控/SIGTERM 不 SIGKILL）
npm run test:phone-bridge-preflight # 19 条上线自检断言（**发送项必须 dry-run**、失败都带修复提示、退出码）
```
