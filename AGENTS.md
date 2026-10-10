# 项目通用规则

## Git 提交规范 (Commit Guidelines)
- **提交语言**：所有的 Git Commit 提交信息（包括标题与详细描述）必须**无条件使用中文**编写。
- **格式规范**：采用 Conventional Commits 规范，格式为 `<type>(<scope>): <中文描述>`。
  - 例如：`feat(review): 新增可审查结果面板`、`fix: 修复文本提取解析异常`、`chore: 忽略构建产物`。

### 配套工具（推荐用它来提交，别用编辑器的提交按钮）

编辑器/IDE 自带的提交集成通常生成英文信息且格式不受控，所以本仓库自带一套工具：

| 命令 | 作用 |
|---|---|
| `npm run commit` | **交互式提交助手**：读取暂存区、按路径推荐 type/scope、拼出规范中文消息、自检后提交 |
| `npm run commit -- --type fix --scope watermark --subject "修正居中定位"` | 非交互式；加 `--print` 只打印不提交 |
| `npm run commit:lint` | 只校验一条消息（`--message "…"` 或 `--file .git/COMMIT_EDITMSG`） |
| `npm run hooks:install` | 启用 commit-msg 钩子（`git config core.hooksPath scripts/hooks`），不合规的提交会被**拦下** |
| `npm run hooks:check` | 查看钩子是否生效 |

规则实现只有一份：`scripts/commit-lint.mjs`（钩子与助手共用），所以不会出现"助手放行、钩子拦截"的漂移。
不允许使用规范时（例如导入外部历史），用 `git commit --no-verify` 临时绕过。

## 文档与实现一致性（改动后请核对）

行为、阈值、参数名、路由、环境变量**只以代码为准**，别据印象写文档：

| 内容 | 唯一来源 |
|---|---|
| 门控类别、planId 构成、计划库/状态机、策略语义、阈值（整档 OCR / 可搜索化共用 20 页门槛、巨型文档 200 页、计划有效期 15 分钟） | `src/core/confirmation.ts` |
| 每个工具的 `authorize({...})` 调用点、`plan` / `confirm` / `force` 参数与默认值 | `src/host/tools.ts` |
| 整行重绘的几何换算（CTM/Tm 追踪、页面坐标原点、页面字号）、抹除方式、跨组重排（同一视觉行兄弟组的 `Tm` 锚点平移、`shiftSiblings` 默认值、溢出判定）、**重画字体家族的选择（`BaseFont` 去子集前缀 → 系统字体表、可渲染性检查、回退与字号估算）**，以及 `pdf_replace_line` 的参数与门控 | `src/core/line-redraw.ts`、`src/core/fonts.ts`、`src/host/tools.ts` |
| `/api/pdf-studio/plans`、`.../{planId}/confirm`、`.../{planId}/cancel`、loopback 信任栅栏 | `src/host/routes.ts`、`src/host/http.ts` |
| 两端注入（**仅 `surface: true` 时**：行表 + `tapIndex` 兜底 + 绝对 `apiBase`；`surface` 默认 false，页面默认无浮层）、`requireConfirmation` / `DSH_PDF_STUDIO_CONFIRM`（只管确认策略） | `src/index.ts` |
| 浮层「待确认操作」卡片、3 秒轮询、`window.__dshPdfStudioStop()`（浮层可选；确认主路径是纯文本确认单） | `public/app.js` |

改了上面任何一处，请同步 `README.md` 的「执行前确认」与「怎么验证」两节，以及 `docs/PROMPTING.md`
的「意图 → 工具 → 关键参数」表与模板。

改动生效方式：**插件代码改动必须重启 DSH 才生效**（`lib/index.js` 是构建产物，改了 `src/**` 先 `npm run build`；
`apply()` 只在启动时跑一次，开了 `surface: true` 时桌面端的注入行表更是启动时一次性收集）。
只有 `surface: true` 时才需要在改完 `public/app.js` 后刷新页面；默认不注入时页面根本不加载它。

提交前跑 `npm test` 即可——确认机制的三份套件已经接进 test 链
（`test:confirm-ui`、`test:plugin-wiring`、`test:confirmation`）。只想单跑其中一套时：

```sh
npm run test:confirmation   # 门控判定 / planId 强校验 / 计划库 / /plans 路由
npm run test:confirm-ui     # 浮层卡片（浮层可选开启）
npm run test:plugin-wiring  # 工具注册 + 注入（默认关闭 / surface:true）+ 策略透传
npm run test:line-redraw    # 整行重绘：几何换算 / 抹除 / 不重叠 / 确认令牌 / 错误路径
```

