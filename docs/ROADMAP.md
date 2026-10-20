# 路线图：向"覆盖大部分 Adobe PDF 编辑功能"推进

> 目标：让这个插件能覆盖 Adobe Acrobat 的**大部分编辑能力**，同时保持"普通人 + 模糊 prompt 也能安全用"。
> 本文是**唯一**的路线图来源；实现方（人或助手）改功能后在状态表里更新一行。

## 三条纪律（不遵守就不做）

1. **不引入新的重依赖。** 新功能只能用现有的 `pdf-lib` / `pdfjs-dist` / `@napi-rs/canvas` / `tesseract.js` / `qpdf-wasm`。
   明确**不做**：数字签名（PKI/时间戳）、PDF/A 归档、PDF/UA 无障碍标签、扫描图内的图像内容修补（改图片里的字）、
   Acrobat 式"自由移动/删除任意图形对象"、段落重排（Word 级 reflow）。最多做"查看/验证签名状态"。
2. **工具总数控制在 ~20 以内。** 同类功能用**动作型工具**合并（一个工具 + `action=`），例如
   `pdf_annotate action=highlight|underline|…`。每个工具的 `description` 不超过 3 行，细则写进 README。
   新增工具前先问："能不能并进已有工具的一个 action？"
3. **重活懒加载、测试分档。** canvas/tesseract 必须在使用处 `require`，不在模块顶层加载；
   OCR/渲染密集的断言不要堆进 `npm test` 主链（可拆独立套件，或按现有惯例用环境变量 SKIP）。

## 现状（已完成）

| 能力 | 工具 |
|---|---|
| 分诊/预览/提取（含 OCR）/可搜索化 | `pdf_inspect`、`pdf_preview`、`pdf_extract_text`、`pdf_make_searchable` |
| 改文字（原地替换 / 整行重绘含跨组重排） | `pdf_edit_text`、`pdf_replace_line` |
| 水印（加/扫/删，含 Adobe 系与 Artifact 包裹检测） | `pdf_watermark` |
| 密码/权限 | `pdf_protect` |
| 页级装配（拆分/裁剪/重排/合并） | `pdf_split`、`pdf_crop`、`pdf_arrange`、`pdf_merge` |
| 答案页候选检测 | `pdf_find_answers` |

工具数：**21（就此封顶）**。纪律②的落地决定：`pdf_compare` 作为 `pdf_optimize` 的一个 action（不再新增工具）；`pdf_batch` **不做成工具**——目录批量本质是编排，用 agent 循环调用现有工具即可（配方写进 `docs/PROMPTING.md`），这样既满足"大部分 Adobe 编辑功能"的覆盖，又守住工具总数。全部接入确认门控（只读工具除外：`pdf_inspect`/`pdf_preview`/`pdf_extract_text`/`pdf_find_answers`）。

## 波次与状态

| 波次 | 功能 | 工具（动作） | 状态 |
|---|---|---|---|
| 一 | 注释标注：高亮/下划线/删除线/方框/椭圆/自由文本/便签/图章 | `pdf_annotate`（8 个 action） | **已完成**（`/F 4` + 所有动作都写 `/AP`；`pdf_inspect` 会报注释；测试 85 条） |
| 一 | 插入文字/文本框；页码/页眉页脚/Bates 编号 | `pdf_text`（`insert`/`page-number`/`header-footer`/`bates`） | **已完成**（写内容流、`{page}` 受 `start` 影响、未知占位符原样保留并提示；测试 32 条含 QuickLook 像素） |
| 一 | 导出页面为图片；图片合成 PDF | `pdf_images`（`export`/`build`） | **已完成**（PNG/JPEG 导出、多图合成、A4/Letter/fit；测试 27 条含往返渲染） |
| 二 | 表单：列字段/填写/扁平化 | `pdf_form`（`list`/`fill`/`flatten`） | **已完成**（含中文值外观刷新；测试 25 条） |
| 二 | 统一页尺寸/缩放、N-up 拼版、小册子 | `pdf_layout`（`resize`/`nup`/`booklet`） | **已完成**（缩放不栅格化、注释错位/丢失都如实提示；测试 30 条） |
| 二 | 文档属性读写与清除 | `pdf_metadata`（或并入 `pdf_inspect`） | **已完成**（属性含中文、书签一层、`clear` 连时间一起清；测试 26 条 + 文档就绪） |
| 二 | 矩形密文（真删内容 + 打框） | `pdf_redact`（`preview`/`apply`） | **文本页已可用**：单段流 + **多段流**（跨流 CTM 累积）都通过；**图片/扫描页按纪律①不做图片修补**：照常写盘但在结果里说明"图片像素未修补"，并给出替代路径（只有框内文字删不掉时才拒绝输出）；两道护栏（目标必须消失、框外行不得减少）保证绝不给假密文；测试 26 条 |
| 三 | 书签/大纲增删改 | `pdf_metadata`（`outline-list`/`outline-set`/`outline-clear`） | **已完成**（合并进 `pdf_metadata`；支持 `children` 多层，最多 6 层，`/Count` 记全部后代数）|
| 三 | 两版 PDF 差异报告（文本 + 像素） | `pdf_compare` | **已完成**（并入 `pdf_optimize profile=compare`，不新增工具；测试 39 条含 compare） |
| 三 | 体积优化（垃圾回收/线性化/清隐藏数据） | `pdf_optimize`（或并入 `pdf_compare`） | **已完成**（`gc`/`linearize`/`both` 走 qpdf 重写对象层，`compare` 见上一行；测试 39 条） |
| 三 | 目录批量流水线 | **不做成工具**（批量是编排） | 已落地为 README/PROMPTING 的 agent 循环配方；每一步仍走确认门控 |

预计新增工具数：**11**（13 → 24；其中 `pdf_metadata`/`pdf_optimize` 若并入已有工具则为 22）。

## 每个功能的完成定义（Definition of Done）

1. **核心模块**放 `src/core/<功能>.ts`（纯逻辑、可单测），工具层只做参数解析 + 门控 + 结果文本；
2. **工具接入** `src/host/tools.ts`：中文描述 ≤ 3 行、参数写清默认值、结果三段式（`已生成：`/做了什么/`注意：`）、
   **写盘一律 destructive 并且未确认绝不落盘**；只读动作（如 `action=list`）不接 `CONFIRM_PARAMS`；
3. **测试** `test/<功能>.test.mjs`：中文断言名，覆盖正常路径 + 错误路径 + 门控（未确认不落盘 / planId 篡改被拒 / 一次性），
   渲染类结论要用**真实 canvas 子进程**做像素断言（参考 `test/support/render-diff.mjs`、`render-ink.mjs`），
   接进 `package.json` 与 `npm test` 链；
4. **文档**：README（工具表 + 新小节 + 已知限制）、`docs/PROMPTING.md`（可复制模板 + 反例）、`AGENTS.md`（来源表）、
   **本文**（状态表）；
5. **真文件验收**：在 `测试pdf文件夹/` 里的真实 PDF 上跑一遍，给出可量化证据（页数/尺寸/像素差/文字是否可提取/`qpdf --check`），
   并确认**源文件未被改动**（sha256）；
6. **工具数变化要同步**所有断言：`test/tools.test.mjs`、`test/confirmation.test.mjs`、`test/plugin-wiring.test.mjs`、
   `test/line-redraw.test.mjs`、`src/index.ts` 的 `TOOL_NAMES`；
7. `npm run build` + `npm test` 双 **exit 0**；**不要 git commit**（提交由用户决定，用 `npm run commit`）。

## 生效方式

`src/**` 改动必须 `npm run build` 并且**重启 DSH** 才会在会话/GUI 里生效；
只改 `public/app.js` 且 `surface: true` 时刷新页面即可。`scripts/**` 与 `test/**` 不需要重启。

## 扩展：手机远控（`feature/phone-bridge`）

| 能力 | 位置 | 状态 |
|---|---|---|
| 飞书指令 → `dsh --profile headless` 执行 → outbox 回传 | **已迁到独立仓库**（客户端与测试）+ `docs/PHONE-BRIDGE.md`（模式文档）| **骨架已完成**（纯逻辑 51 条测试 + 不联网自检 6 项；`npm test` 26 套件 exit 0）。待办：真机联调（需用户提供 chat_id、续期 lark-cli 授权、允许试跑一次 headless）；可选 Tailscale HTTP 直下（需给插件端点加 token，当前是 loopback-only） |

## 2026-10 真实文档实测暴露的问题（待办）

在两份真实家长用试卷上跑完整流程（26 页图片型试卷 + 48 页图片型知识点总结）时暴露的问题。
**全部来自实测，不是推测**；每条都记下当时的可复现证据，便于以后修。

### P0（真实挡路）

| # | 问题 | 实测证据 | 影响 |
|---|---|---|---|
| 1 | **不能删改页面图片里的内容**：`pdf_redact` 只在框内**追加不透明色块**（不删图），`pdf_text` 的 `background` 也能压一块 —— 两者都只能"视觉遮盖"，底层图片数据仍在 | 试卷页眉（logo + 二维码）与正文同处一张页面图片；实测 `pdf_redact` 即使删文字成功也不动图片像素（代码注释：如实说明只做视觉遮盖） | 这类页眉**无法真正删除**，只能遮盖；要干净只能 `pdf_images export → 外部涂 → build → merge`（4~5 步，且被处理页整页变图片、文字不可搜） |
| 2 | **`pdf_watermark action=add` 的图片水印用固定资源名** | 同一文件连续两次 `add`（先盖二维码、再盖 logo）→ 第二张把第一张顶掉，二维码又露出来 | 想遮盖多处必须先把多块拼成一张图；文档需写明"一次只加一张图" |
| 3 | **遮盖高度依赖页面版式**（"盖住页眉"可能切正文） | 该试卷页眉底边 y≈776pt，而第 2 页正文顶在 y≈752pt；白带取 86pt 切正文，取 68pt 才刚好躲开 | 遮盖高度是"试出来的"，换一份排版就翻车；根治要靠第 1 条（真删对象） |

### P1（能用但绕）

| # | 问题 | 实测证据 |
|---|---|---|
| 4 | **带 `/Encrypt` 的文件，所有 pdf-lib 写盘路径都直接拒载**（不是"不自动解密"这么轻） | `watermark.ts:494-500` 翻译成中文「请先 decrypt」；`redact.ts:157` 抛 pdf-lib 原始英文错（**两处口径不一致**）；受影响的不止这两个工具（`pdf_text`/`pdf_annotate`/`pdf_form`/`pdf_metadata` … 同样）|
| 5 | **`pdf_redact` 拒绝分支的文案主次不理想** | 只有"框内文字删不掉"才拒绝；此时先归因"文字分散在多个内容流/嵌套结构"，图片说明排在「另外：」之后（判据是 `imagePages` 而非 `imageOnlyPages`）。图片页本身**不会**被拒绝（照常写盘 + 提示）|
| 6 | **`pdf_text action=insert` 的 `rect` 只有 x/y 生效**，width/height 不参与绘制；`background` 的尺寸由**文字宽度**决定 | 文档已写"宽高仅用于汇报"；想盖住 100×70 的区域做不到（除非凑出那么宽的文字）→ 准确说法是**暂无任意宽高的色块动作** |
| 7 | **`pdf_text action=insert` 传纯空格被判为缺参数** | `text: "   "` → 确认单报「缺少关键参数：要插入的文字」，"空格 + 背景色当色块"的做法不可行 |
| 8 | **`pdf_watermark` 的 `pages` 只接受数组** | 盖第 5–48 页要传 44 个数字；而 `pdf_crop`/`pdf_text`/`pdf_images` 支持 `"1-3,7"` 这类区间字符串，参数风格不一致 |
| 9 | **图片水印宽度超过页宽时有风险** | 用 700px 宽白带（页宽 595pt）时输出疑似丢正文（当时未定性，需复现）；建议自动裁到页宽或明确告警 |

### P2（流程效率）

| # | 问题 | 实测证据 |
|---|---|---|
| 10 | **一个交付要过 5~6 张确认单** | 试卷：decrypt → remove → add(二维码) → add(logo)；知识点总结：export → paint → build → merge。缺"一次授权、链式执行"或"批量确认" |
| 11 | **缺少"页面图片修补向导"** | 本次最顺的路线其实是 `export(某页) → 涂 → build → merge(ranges)`，值得封装成一个动作（例如"在页 N 的矩形区域涂色"） |

### 本次表现良好、应保留的行为（也是实测）

- `pdf_watermark scan` 的**判定理由**写得很清楚（能指名 `Form XObject` 的 `/PieceInfo`、`ADBE_CompoundType`、`/Private /Watermark`）；
- 水印**对象级真删**成功（26/26 页，逐页报告 `已移除水印 XObject /KSPX1`）；
- `pdf_redact` 的**护栏**正确：宁可拒绝输出，也不产出"看起来涂黑、其实还能复制"的假密文；
- `pdf_protect action=check` 能区分"需要密码才能打开"与"仅权限受限"；
- `pdf_watermark remove` 对"图片式水印"**如实拒绝**，不装成功；
- 交叉验证手段有效：用 Apple PDFKit（`PDFOutline`）独立读大纲目标页，证明书签层级正确。

### 与"工具数 21 封顶"（纪律②）的关系

上面 P0 第 1 条**不应该**新增工具，建议按纪律②并入已有工具：

- 首选：`pdf_redact` 增加一个动作（例如 `action=patch`），语义是"在指定矩形内**重绘背景色**"——
  与现有 `preview`/`apply` 共用矩形参数与门控，区别只在于它**不动文字**、只覆盖该区域的**图片像素绘制**；
- 备选：`pdf_watermark` 增加 `action=cover`（"覆盖"与"水印"同族，且天然懂"该页有哪些图片对象"）。

无论哪种，都要求：**不栅格化整页**、文字层保持可提取、只影响框内、写盘前复核（框外像素/文字不得变化）。

### 结论

这批问题的共同根源是：**图片型 PDF（整页扫描/导出图）在工具集里缺少"原位、局部、非栅格化"的图片修补能力**。
P0 第 1 条若落地，今天的两个文件都不需要"盖白带"这种妥协。
