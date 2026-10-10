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
| 体积/结构优化与两版差异：`profile=gc|linearize|both` 走 qpdf 重写对象层（`--object-streams=generate` / `--compress-streams=y --recompress-flate` / `--remove-unreferenced-resources=yes` / `--linearize`），结果在 `result.bytes`（`output` 只是诊断）；**实测可能不省体积甚至略增**（对象流有开销），结果必须如实报字节数；`profile=compare` 是**只读**（门控里按 action 区分，destructive 策略下也直通），以**文字层**逐页比对、无文字层如实说"无法比对"；**目录批量刻意不做工具**（编排用 agent 循环，配方在 README/PROMPTING） | `src/core/optimize.ts`、`src/core/compare.ts`、`src/host/tools.ts` |
| 文档信息与书签：属性读写用 **`PDFHexString.fromText`**（`PDFString.of` 存中文变乱码；1.17 没有 `PDFString.fromText`）；`clear` 连 `CreationDate`/`ModDate` 一起删；书签 `/Dest` 写 `[页面引用 /Fit]`；`setOutline` **只支持一层扁平**；`get`/`outline-list` 只读直通 | `src/core/docinfo.ts`、`src/host/tools.ts` |
| 矩形密文：**真删**（把命中的字符串操作数换成空串 `<>`/`()`，不重新序列化整条流）；写回是"该页所有流各自 `q…Q` 包住后**合并成一条新流**"（按 `/Contents` 下标或引用匹配都会改错位置，最小复现证据在案）；**写盘前强制复核**（框内文字仍能提取就拒绝输出，防假密文）；**坐标要跨流累积 CTM**（`trackGraphicsState` 只看单条流，而缩放 `cm` 常在前一条流里——`pdf_layout resize` 的产物就是这种；不累积就会"报告删了、其实没删"）；**护栏：目标没删掉、或框外行变少，都拒绝输出**（防假密文、防误删）；**图片/扫描页不做图片内容修补（纪律①）**，会明确拒绝并指向"导出图片→涂黑→合成" | `src/core/redact.ts`、`src/host/tools.ts` |
| 版面重排：`resize` 用 `copyPages` + 改 `/MediaBox`/`/CropBox` + **内容流前插 `q s 0 0 s tx ty cm … Q`**（不栅格化、文字保持原生；比 `embedPage` 省 37KB）；`nup`/`booklet` 用 `embedPage` + `drawPage` 网格（行从上往下排）；`bookletSheets` 的对折顺序（第 1 面 = 末页+首页）；**缩放不会带注释一起缩、拼版会丢注释**，两者都必须在结果与确认单里提示 | `src/core/layout.ts`、`src/host/tools.ts` |
| 表单：`list`（只读，列名字/类型/值/可选项）/`fill`/`flatten`；**中文值必须用 CJK 字体重刷字段外观**（pdf-lib 默认 Helvetica 会抛 `WinAnsi cannot encode`，实现里在 fill 后用 `form.updateFieldAppearances`）；字段名不存在要报错并列出可用名；`fill`/`flatten` 归 destructive、`list` 只读直通；`PDFDropdown.getSelected()` 返回**数组** | `src/host/tools.ts` |
| 图片互转：`export` 用 `renderPagePng`/`renderPageJpeg`（缩放倍率→DPI 换算：1=72、2=144、3=216dpi）写目录；`build` 用 pdf-lib `embedPng`/`embedJpg` 按 `pageSize=a4|letter|fit` 与 `margin` 排布；**两个 action 都归 destructive**；JPEG 转码放在 `render.ts`（工具层是 ESM，裸 `require` 会 ERR_AMBIGUOUS_MODULE_SYNTAX） | `src/host/render.ts`、`src/host/tools.ts` |
| 页面写字：`insert`/`page-number`/`header-footer`/`bates` 共用"模板求值 → 锚点定位 → 实测宽度画字"；**写内容流（文档内容，可搜索/可打印）而不是注释层**；`{page}` 从 `start` 起按**选中顺序**递增；**未知占位符原样保留并在结果里提示**；锚点用 `widthOfTextAtSize` 实测宽度居中/右对齐；纯 ASCII 走内置 Helvetica、含中文才嵌 CJK（先 registerFontkit） | `src/core/page-text.ts`、`src/host/tools.ts` |
| 注释标注：8 个 action → `/Highlight` `/Underline` `/StrikeOut` `/Square` `/Circle` `/FreeText` `/Text` `/Stamp`；**每个注释都要 `/F 4`（Print）**，**文本标记与方框/椭圆都必须写 `/AP` 外观流**（PDFKit/预览不会自己画，实测不带 `/AP` 时 0 像素差异）；`find` 用文字层按字符占比插值定位（跨行只取第一行）；用户文字用 **`PDFHexString.fromText`**（`PDFString.of` 会把中文存成乱码）；`/Annots` 元素是间接引用，统计时必须 `context.lookup(ref)` | `src/core/annotate.ts`、`src/host/tools.ts` |
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
npm run test:annotate       # 注释标注：8 个 action 的结构 / /F 4 / /AP 必须存在 / 门控 / QuickLook 像素断言
npm run test:pdf-text       # 页面写字：模板占位符 / start 与 Bates 递增 / 中文可提取 / 未知占位符 / 门控
npm run test:pdf-images     # 图片互转：格式魔法字节 / 尺寸与 DPI / 合成页数 / 门控 / 往返渲染
npm run test:pdf-form       # 表单：列字段 / 填空（含中文回读）/ 压平 / 字段名报错 / 门控
npm run test:pdf-layout     # 版面重排：缩放后尺寸与文字坐标 / N-up 纸张数 / 小册子对折顺序 / 注释提示 / 门控
npm run test:pdf-redact     # 矩形密文：删除前后提取对照 / 空框不虚报 / 门控 / 分档标注（当前单流档）
npm run test:pdf-metadata   # 文档信息：中文属性回读 / 时间字段清除 / 书签 /Dest 指向页面 / 只读直通 / 门控
npm run test:pdf-optimize   # 优化与比对：结构/文字不变 + qpdf 通过 / 字节数如实报告 / compare 增删行 / 门控
npm run typecheck           # 类型检查（tsc --noEmit；需先装 devDeps: typescript + @types/node）
npm run test:commit-tools   # 提交工具：自动草稿推断优先级 / 夹具不编标题 / R1+R2（含裸 --staged）+ R3
```

