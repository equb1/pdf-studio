# 项目通用规则

## Git 提交规范 (Commit Guidelines)
- **提交语言**：所有的 Git Commit 提交信息（包括标题与详细描述）必须**无条件使用中文**编写。
- **格式规范**：采用 Conventional Commits 规范，格式为 `<type>(<scope>): <中文描述>`。
  - 例如：`feat(review): 新增可审查结果面板`、`fix: 修复文本提取解析异常`、`chore: 忽略构建产物`。

### 配套工具（推荐用它来提交，别用编辑器的提交按钮）

编辑器/IDE 自带的提交集成通常生成英文信息且格式不受控，所以本仓库自带一套工具：

| 命令 | 作用 |
|---|---|
| `npm run commit` | **交互式提交助手**：读取暂存区、按路径推荐 type/scope、拼出规范中文消息、自检后提交。自动草稿以 `src/**` 的改动为准（按变更行数定主导模块，`test`/`docs` 抢不走 scope；scope 与 type 相同时省略 scope，不产出 `test(test)`）；**二进制文件与 `test/fixtures/**` 不作为标题素材**，推断不出有意义的标题时会拒绝并要求显式 `--subject`，不会生成"新增 N 个文件"或 `新增a测试` 式的空话 |
| `npm run commit -- --type fix --scope watermark --subject "修正居中定位"` | 非交互式；加 `--print` 只打印不提交 |
| `npm run commit:lint` | 只校验一条消息（`--message "…"` 或 `--file .git/COMMIT_EDITMSG`）。**裸 `--staged`（不带值）与完全不给 `--staged` 一样，都会自动读 `git diff --cached --name-only`**，只有显式给了路径列表才用该列表（否则 R2 会静默失效）。规则：R1 空话标题 / R2 scope 与暂存区不一致 / R3 标题像文件名碎片 |
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
| 页级装配的几何与判定：页面框继承（`/MediaBox`/`/CropBox`/`/Rotate`/`/UserUnit` 沿页树向上找）、可见区域 = CropBox ∩ MediaBox、2-up 判定（`/Rotate` 为 0 且长宽比 ≥ 1.25，与纸张尺寸无关）、拆分的页面框改写 + 内容流平移（不栅格化）、`keep` 只留一半、中缝检测（内容框间隔 ≥ 8pt、偏离中线 > 15% 回退、`MIN_CONTENT_LINE_RATIO`）、裁剪只裁不缩与 trim 的 uniform 并集、页序解析、合并的来源回报 | `src/core/page-assembly.ts` |
| `pdf_split` / `pdf_crop` / `pdf_arrange` / `pdf_merge` 的参数、默认值与 `authorize({...})` 调用点（四个工具一律 destructive，见 `PAGE_ASSEMBLY_TOOLS`） | `src/host/tools.ts`、`src/core/confirmation.ts` |
| 答案页候选的判定：权重（标题词 +5 / 速查表 +4 / 解答句 +2 / 题干每类 −2）、**先算强信号再看"文本过少"**（命中标题词/速查表不受字数门槛限制；没有强信号时才用 `< 20` 有效字符判 unknown，依据里回显识别文字便于核对计数）、速查表要求**连续递增 +1 且相邻间隔 ≤ 24 字符**、字母认 **A–F**（选项列表 `A,5 B,4 C 3 D,2` 不算速查表）、位置先验只在总分绝对值 ≤ 1 且末 25% 页时 +0.5 且**只进「位置推断（仅供参考）」一节——不进候选区间、不进 order**、`mixed`（答案侧 + ≥2 类题干）与"不做内容级分离"的边界、区间合并取最弱页置信度、拆分建议的 order 压缩 | `src/core/answer-pages.ts` |
| `pdf_find_answers` 的参数与默认值（`pages` / `ocr` 默认 true / `lang` 默认 `chi_sim+eng`）、**只读工具不接 `CONFIRM_PARAMS`**、整档 OCR > 20 页走 `expensive`（与 `pdf_extract_text` 同一阈值口径）、OCR 语言数据按**选定 gzip 模式逐语言**核对后显式退化 | `src/host/tools.ts`、`src/core/confirmation.ts`、`src/core/ocr.ts` |
| OCR 语言数据目录的解析优先级（插件配置 `tessdataPath` > `DSH_PDF_STUDIO_TESSDATA` > 兜底绝对路径）、`inspectLanguageData` 的 gzip 模式选择与逐语言 `missingForms`、混装目录的降级（tesseract 缺语言文件时抛的是 worker 未捕获异常，会打崩进程） | `src/core/ocr.ts`、`src/index.ts` |

改了上面任何一处，请同步 `README.md` 的「执行前确认」与「怎么验证」两节，以及 `docs/PROMPTING.md`
的「意图 → 工具 → 关键参数」表与模板。

改动生效方式：**插件代码改动必须重启 DSH 才生效**（`lib/index.js` 是构建产物，改了 `src/**` 先 `npm run build`；
`apply()` 只在启动时跑一次，开了 `surface: true` 时桌面端的注入行表更是启动时一次性收集）。
只有 `surface: true` 时才需要在改完 `public/app.js` 后刷新页面；默认不注入时页面根本不加载它。

提交前跑 `npm test` 即可——确认机制的三份套件与页级装配套件都已接进 test 链
（`test:confirm-ui`、`test:plugin-wiring`、`test:confirmation`、`test:page-assembly`）。只想单跑其中一套时：

```sh
npm run test:confirmation   # 门控判定 / planId 强校验 / 计划库 / /plans 路由
npm run test:confirm-ui     # 浮层卡片（浮层可选开启）
npm run test:plugin-wiring  # 工具注册 + 注入（默认关闭 / surface:true）+ 策略透传
npm run test:line-redraw    # 整行重绘：几何换算 / 抹除 / 不重叠 / 确认令牌 / 错误路径
npm run test:page-assembly  # 页级装配：拆分 / 裁剪 / 重排 / 合并（含真实 canvas 回拼比对）
npm run test:answer-pages   # 定位答案页：打分权重 / 零误报 / 位置先验只做 tiebreak / mixed / OCR 开关
npm run test:commit-tools   # 提交工具：自动草稿推断优先级 / 夹具不编标题 / R1+R2（含裸 --staged）+ R3
```

