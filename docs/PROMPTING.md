# 提示词指南：怎么让助手把 PDF 做对

面向**普通用户**和**他们的助手**。文中的工具名、参数名、枚举值都取自
`src/host/tools.ts`，阈值取自 `src/core/confirmation.ts`（整档 OCR / 可搜索化 > 20 页、
整档 > 200 页、计划有效期 15 分钟）与 `src/core/page-assembly.ts`
（2-up 判定长宽比 ≥ 1.25、中缝间隔 ≥ 8pt、缝偏离中线 > 15% 回退、trim 默认留白 6pt、
A4 提示容差 ±3pt）。机制细节见 README 的「执行前确认」与「页级装配」。

复制下面任意一段就能用。把 `<路径>`、`<文字>` 换成你自己的值。

---

## 一、三条原则

### 1. 一次说全「文件 → 动作 → 参数 → 输出 → 验收」

缺任何一项，插件要么先给你一张确认单、要么（缺关键参数时）直接拒绝——它不会替你猜。最省事的句式：

```
文件：<绝对路径>
动作：<要做什么>
参数：<页 / 颜色 / 文字 / 模式…>
输出：<写到哪个文件>
验收：<做完怎么证明对了>
```

### 2. 用工具里的词，不要用感觉的词

| 别这么说 | 这么说 |
|---|---|
| "弄好看点" | `placement=center`、`opacity=0.15`、`fontSize=48` |
| "淡淡地铺满" | `placement=tile`、`opacity=0.1` |
| "别留痕迹" | `render=outline`（矢量轮廓，**不进入文字层**） |
| "扫描的" | "图片页，走**扫描页 OCR**"（`pdf_make_searchable`） |
| "加个能搜的层" | `mode=invisible`（文字层不可见，外观不变） |
| "就是原文件另存" | `output=<具体路径>`（不给就是源文件旁的 `-edited` / `-searchable` 等新文件） |

### 3. 先探再改，改完自证

让助手先回答"这是什么文件、几页、每页是文字页还是扫描页、有哪些可改的文字块 id"，
拿到结论再动手；做完再回读一次输出文件，把"哪里变了、哪里没变"报给你。
`pdf_inspect` + `pdf_preview` 负责探，`pdf_extract_text` 负责拷问输出。

---

## 二、意图 → 工具 → 关键参数

| 我想… | 工具 | 关键参数 |
|---|---|---|
| 先看看这是什么 PDF | `pdf_inspect` | `path`；深层分诊加 `analyze: true`（慢）；列可改文字块加 `runs: true` |
| 看到页面长什么样 | `pdf_preview` | `path`、`pages`（最多 4 页）、`scale`（默认 1.4，上限 3） |
| 读出文字并知道在哪一行 | `pdf_extract_text` | `path`、`page`（1 起，省略=全部）、`ocr`（默认开） |
| 扫描件变成能搜的 PDF | `pdf_make_searchable` | `path`、`mode: invisible\|cover`、`output` |
| 改掉 PDF 里原有的文字（等长/原地） | `pdf_edit_text` | `path`、`edits: [{page, targetId, to, fontSize?}]`、`output` |
| 把一个词改长/改短（不与后文重叠） | `pdf_replace_line` | `path`、`page`、`targetId`（目标行里任意一个文字块 id）、`text`（这一整组的新文字）、`fontSize?`、`shiftSiblings?`（默认 true：同一视觉行右侧片段整体右移让位）、`output` |
| 加水印 | `pdf_watermark` | `action: add`、`text` 或 `imagePath`、`render: text\|outline`、`placement: tile\|center\|corner`、`corner: top-left\|top-right\|bottom-left\|bottom-right`、`rotation`、`opacity`、`fontSize`、`color`、`margin`、`artifact`、`pages`、`output` |
| 查水印 | `pdf_watermark` | `action: scan`（只读，不改文件）。结果分两段：默认门槛内可删的，和"看到了但要你确认"的（例如页眉类 artifact，置信度 0.7） |
| 删水印 | `pdf_watermark` | `action: remove`、`minConfidence`（默认 0.9；要删 0.7 的页眉类候选必须显式传 0.7）、`output` |
| 加密 / 解密 | `pdf_protect` | `action: encrypt\|decrypt`、`password`、`allow`（`print` / `modify` / `extract` / `annotate` / `form` / `assembly` / `high-quality-print`）、`output` |
| 查加密状态 | `pdf_protect` | `action: check`（只读） |
| 把 2-up 拆成单页（A3 试卷 / 并排讲义） | `pdf_split` | `path`、`layout: auto\|left-right\|top-bottom`、`keep: both\|left\|right\|top\|bottom`、`gutter: middle\|auto`、`pages`、`targetSize: a4\|keep`、`output` |
| 批量裁掉白边 / 裁到指定矩形 | `pdf_crop` | `path`、`mode: fixed\|trim`、`box: {left,bottom,right,top}`（fixed 必填）、`margin`（默认 6pt）、`uniform`（默认 true）、`setCropBoxOnly`、`pages`、`output` |
| 重排页序 / 删页 / 转正某几页 | `pdf_arrange` | `path`、`order`（必填：`1,3,5` / `1-3,7` / `odd-even` / `reverse` / `swap-pairs`）、`delete`、`rotate: {pages, angle}`、`output` |
| 把多个文件按顺序合并 | `pdf_merge` | `paths`（≥2 个）、`ranges`（与 `paths` 一一对应，可省）、`output` |
| 找出哪几页是答案（只看不改） | `pdf_find_answers` | `path`、`pages`（省略=全部，支持 `5-7`）、`ocr`（默认 true；false 时图片页标"未做 OCR"）、`lang`（默认 `chi_sim+eng`）。结果给候选页 + 中文依据 + 置信度，**不给确认单** |
| 把答案与试卷拆成两个 PDF | `pdf_find_answers` → `pdf_arrange` | 先 `pdf_find_answers` 拿候选，确认后用返回的两条 `pdf_arrange order="1-6"` / `order="7"` 各导出一次 |
| 只想先看计划，不要执行 | 除 `pdf_preview`、`pdf_find_answers` 外的 11 个工具 | `plan: true`（`watermark action=scan`、`protect action=check` 这两个只读分支不会返回计划） |

默认值（不指定时实际生效的值）：水印 `render=text`、`placement=tile`、`opacity=0.15`、`minConfidence=0.9`（仅 remove）、
`fontSize=48`、`color=#d92626`、`margin=24`、`artifact=true`、`pages=全部`（`rotation` 平铺时 45°、其它 0°）；
可搜索化 `mode=invisible`；加密只给 `print` 权限；页级装配里拆分 `layout=auto`、`keep=both`、
`gutter=middle`、`targetSize=a4`；裁剪 `mode=fixed`、`margin=6`、`uniform=true`、`setCropBoxOnly=false`。
默认输出名：
`-searchable.pdf` / `-edited.pdf` / `-line-redrawn.pdf` / `-watermarked.pdf` / `-clean.pdf` / `-protected.pdf` / `-unlocked.pdf` /
`-split.pdf` / `-cropped.pdf` / `-arranged.pdf`（合并默认是 `<第一个文件名>-merged.pdf`，落在第一个文件所在目录）。

---

## 三、12 个可直接复制的模板

### 模板 1 · 先探后报（什么都不改）

```
先只做检查，不要改任何文件：
1) 用 pdf_inspect 看 <路径>：页数、是否加密、每页是文字页还是扫描页；
2) 用 pdf_preview 渲染第 1 页给我看；
3) 把所有页的类型和页数汇总成一行，并告诉我如果要改文字，需要先做哪一步。
```

### 模板 2 · 扫描件转可搜索

```
把 <路径> 做成可搜索 PDF：
- mode=invisible（文字层不可见，页面外观不变）
- output=<输出路径>.pdf
- 做完用 pdf_extract_text 抽第 1 页，确认能提取到中文
- 告诉我：原文件字节没变、输出文件页数、能提取到的字符数
注意：这是扫描件，图片页要走 OCR。
```

### 模板 3 · 精确改写（含 id 生命周期）

```
改写 <路径> 里的文字，分两步：
第一步：pdf_inspect path=<路径> runs=true，把第 2 页的文字块列表给我（id、字号、原文）。
第二步：按 id 改：
  pdf_edit_text path=<路径>
    edits=[{"page":2,"targetId":"2:6","to":"<新文字>"}]
    output=<输出路径>.pdf
改完重新 runs=true 读一次输出文件，确认：
  - 这一处文字确实变了
  - 其余文字块逐条与改前一致
  - 新的 id 是多少（改写后 id 会整体前移，必须重新读取，不要沿用旧 id 再改一次）
如果结果是「没有应用任何改写（0/N）」，说明 id 过期或这一页没有文字层：
先 runs=true 重读 id；如果这页是图片页，就先 pdf_make_searchable 生成可搜索副本再改。
```

### 模板 4 · 加水印（不污染文字层）

```
给 <路径> 加水印：
- 文字：<水印文字>
- render=outline（画成矢量轮廓，不进入文字层，不能被文本提取）
- placement=tile、opacity=0.15、color=#d92626
- pages=[1,3]（只加这两页）
- output=<输出路径>.pdf
加完用 pdf_extract_text 扫一遍输出文件，确认提取不到「<水印文字>」。
```

### 模板 5 · 查水印 / 删水印

```
先查后删，不要一步到位：
1) pdf_watermark action=scan path=<路径>，把候选（第几页、置信度、理由）列给我；
2) 只删置信度 ≥ 0.9 的，action=remove，output=<输出路径>.pdf；
3) 删完再 scan 一次输出文件，把剩下的候选和无法处理的原因报给我。
如果有栅格化进页面图片、或当正文画的水印，直接告诉我删不掉，不要试。

如果 scan 报了「另有 N 个候选置信度低于默认删除门槛 0.9」（典型是
/Artifact<</Subtype/Header>> 包裹的页眉类对象，置信度 0.7）：把那几条原文念给我，
问清是不是水印；我说是，才用 minConfidence=0.7 重跑 remove。
不要自己替我放宽门槛，也不要把它们说成"已找到可删水印"。
```

### 模板 6 · 加密与解密

```
加密：pdf_protect action=encrypt path=<路径> password=<密码> allow=[print]
      output=<输出路径>.pdf
      做完用 action=check 复核，并明确告诉我「需要密码才能打开」。

解密：pdf_protect action=decrypt path=<加密文件> password=<密码>
      output=<输出路径>.pdf
      做完用 action=check 复核，并告诉我「未加密」。
密码不要写进任何输出文件或日志。
```

### 模板 7 · 把某个词改长/改短（整行重绘，不与后文重叠）

```
把 <路径> 里的「<原词>」改成「<新词>」（会变长/变短）：
第一步：pdf_inspect path=<路径> runs=true，把第 <页码> 页包含「<原词>」的那个文字块的 id 给我，
        并把该 id 前后的文字一起报出来（我要确认这一整组里都写了什么）。
第二步：用整行重绘（不是 pdf_edit_text）：
  pdf_replace_line path=<路径>
    page=<页码>
    targetId=<上一步的 id>
    text="<这一整组的新文字>"
    output=<输出路径>.pdf
    （可选 shiftSiblings：默认 true——同一视觉行右侧的片段会整体右移让位；
      不想动版面、宁可自己承担重叠时传 false）
第三步：用 pdf_extract_text 回读输出文件，确认：
  - 新文字能提取到，旧文字提取不到；
  - 这一行的 bbox 与上下行都不相交（没有压字）；
  - 同一视觉行里新文字右边界 ≤ 右侧片段的新起点（跨组重排生效）；
  - 其它行的文字和坐标逐条与改前一致；
  - 源文件字节没变。
结果里若出现「已把同一视觉行右侧 N 个片段整体右移 X.XXpt」，那是跨组重排生效的正常汇报；
「字体处理：沿用原文的字体家族 …」也是正常；若出现「已改用 …（字面可能略有差异）」，说明原文字体
画不了新文字（例如 Times 画不了汉字），插件换了字体并按估算调过字号，如实转述即可。
若出现「无法平移相邻片段…」或「超出页面」，按上面的说明如实转述，不要当成成功。
如果结果里的「注意：」说这一组还包含别的文字，先把组内原文念给我听，再决定是整组重写还是改用 pdf_edit_text。
```

### 模板 8 · 把 A3 试卷拆成 A4 / 只要空白版

```
把 <路径> 这份 2-up 讲义拆成单页：
- layout=auto（按页面方向自动判断左右还是上下切）
- gutter=middle（缝就在正中；如果缝偏了再改成 gutter=auto 让它自己找）
- targetSize=a4（切出来不是 A4 时告诉我，但不要因此不拆）
- output=<输出路径>.pdf

做完告诉我：
1) 处理了哪几页、每页切出两页的对应关系；
2) 输出页数、每页尺寸（pt），以及是不是 A4；
3) 有没有被跳过的页、原因是什么（旋转页 / 比例接近 1 的页会被跳过）；
4) 回读输出文件，确认第 1 页能提取到左半的文字、第 2 页能提取到右半的文字，且互不串页。

如果我只想要学生版（空白题那半）：把 keep=right（答案版则是 keep=left），
这样每页只输出 1 页，不用先拆成两份再删。
注意：拆分只改纸张边界、不缩放；要 A4 可打印尺寸需要后续缩放能力，当前版本不做。
```

### 模板 9 · 批量裁掉扫描件的黑边

```
把扫描件 <路径> 的黑边/白边收干净：
- mode=trim（逐页渲染找内容边界，再按 margin 留白）
- margin=6（单位 pt；想留多一点就说 margin=18）
- uniform=true（取所有页边界的并集，保证裁完每页尺寸一致）
- output=<输出路径>.pdf

做完告诉我：
1) 裁了几页、每页的裁切框 [x0,y0,x1,y1] 与裁掉的比例；
2) 有没有页被收拢（裁切框越出页面可见区域）或没检测到内容；
3) 用 pdf_preview 渲染第 1 页给我看，确认内容没有被切掉。

注意：只裁不缩（不缩放内容、不改字号）；边界来自低倍渲染的暗像素，很浅的灰底可能不算内容。
如果我已经量好了框，就改用 mode=fixed，box={"left":…,"bottom":…,"right":…,"top":…}。
```

### 模板 10 · 重排页序（先奇后偶 / 自定义顺序）

```
重排 <路径> 的页序：
- order=<顺序，例如 1,3,5,2,4,6 或 1-3,7,4-6；也可以是预设 odd-even / reverse / swap-pairs>
- （可选）delete=<要删掉的原页号，例如 9,10>
- （可选）rotate={"pages":"1-3","angle":90}（pages 指重排后的页号，只改 /Rotate）
- output=<输出路径>.pdf

做完告诉我：
1) 原页数 → 输出页数，删掉了哪几页；
2) 输出页序（每个输出页对应原第几页）；
3) 哪里旋转了、从多少度到多少度；
4) 回读输出文件确认页序正确、页数对得上。

说明：pdf_arrange 只改顺序和 /Rotate，不裁剪、不缩放。
```

### 模板 11 · 把三个文件按顺序合并

```
把这三个文件按顺序合并成一个：
- paths=[<文件1>.pdf, <文件2>.pdf, <文件3>.pdf]（按这个顺序拼接）
- ranges=["1-3", "", "2"]（与 paths 一一对应；空串表示整份取全；不需要就整条省掉）
- output=<输出路径>.pdf（不给就落在第一个文件旁边：<第一个文件名>-merged.pdf）

做完告诉我：
1) 合并后的页数；
2) 每个文件取了哪些页、对应输出第几页（逐文件列出来源）；
3) 三个源文件的字节都没变。
```

### 模板 12 · 把答案和试卷拆成两个 PDF

```
这个 PDF 是"试卷 + 答案"，先帮我确认哪几页是答案，我确认后再拆：
- 第一步：pdf_find_answers path=<文件>.pdf（只读，不拆分；扫描页默认走 OCR，只看某几页就加 pages=6-7）
- 第二步：把它给的候选页范围、置信度与逐页依据**原样**贴给我，等我确认；**不要**在这一步之后就动手
- 第三步：确认后按它给的两条命令各导出一次（都是新文件，源文件不动）：
  pdf_arrange path=<文件>.pdf order=<试卷页码> output=<输出路径>-试卷.pdf
  pdf_arrange path=<文件>.pdf order=<答案页码> output=<输出路径>-答案.pdf

做完告诉我：
1) 候选是哪几页、置信度与依据（哪几页判成试卷、哪几页 mixed / 无法判定）；
2) 若判成 mixed（答案与题目同页），不要硬拆，只说明"无法按页分离"并让我人工确认页码；
3) 若候选为空，就直说"未找到答案页"，不要凑一个候选；
4) 两个输出文件的页数与页序，以及源文件字节没变。
```

---

## 四、确认机制怎么配合

**什么时候会收到确认单**（工具不写盘，只回一张计划）：

- 破坏性操作：改写正文（`pdf_edit_text`）、整行重绘（`pdf_replace_line`）、删水印（`remove`）、加密 / 解密（`encrypt` / `decrypt`），以及**全部四个页级装配工具**（`pdf_split` 拆分、`pdf_crop` 裁剪、`pdf_arrange` 重排、`pdf_merge` 合并）——它们改的是页面结构 / 顺序 / 几何，一律先出确认单；
- 输出文件**已经存在**（会被覆盖）——任何用 `output` 的工具都可能命中，包括加水印；
- 代价高（默认策略下**不会**自动拦，见本节末「默认问哪几类」）：`pdf_inspect analyze=true`、`pdf_extract_text` 整档且页数 > 20、`pdf_find_answers` 整档且 `ocr` 为真、页数 > 20、`pdf_make_searchable` 页数 > 20；
  - `pdf_find_answers` 是**只读**工具，没有 `plan` / `confirm` / `force` 参数。它在 `always` 策略下遇到上面这条时只回一张确认单，让你把 `pages` 拆成不超过阈值的几段分别调用（例如 `pages=1-20`、`pages=21-40`）——不是"带 confirm 继续"那条路。
- 有歧义：没给水印文字 / 图片；整档且页数 > 200；你说的是文件名而它对应多个文件（这一种直接拒绝并列出候选）；
- 你或助手显式要求 `plan: true`（即使本来不需要确认，也先给计划）。

**确认单怎么读**：它按固定顺序列出 `文件：`（名称、大小、最后修改时间）→ `动作：`（中文标题）→ `参数：` →
`默认值：…（你没指定，用了这些）` → `原因：…`（为什么被拦下来，例如"可搜索化：21 页超过 20 页阈值"）→
每条 `影响：` → `待确认：`（歧义项）→ `要改哪一项直接说，例如：`，最后是 `计划 id：p_…（15 分钟内有效）`。
看到不接受的默认值或原因，直接说"改哪一项"即可。

**默认问哪几类**：默认策略是 `destructive`，它问**两类**——「会改文件」和「有歧义」。所以缺参数、
同名多文件、整档 > 200 页在默认配置下就会弹确认单；只有「整档 OCR > 20 页、`analyze=true` 深层分诊、
可搜索化 > 20 页」这类**高成本**操作默认不问，要配成 `always`
（profile 里的 `requireConfirmation`，或环境变量 `DSH_PDF_STUDIO_CONFIRM=always`）才问。
`never` 则什么都不问（不建议）。

**有两条不看策略、也没有商量余地**：缺关键参数（如没给水印文字）一定先给你一张确认单，
补齐之前**带上 confirm 也不能执行**；一个名字对应多个文件则直接拒绝并列出候选，让你指明路径。

**你说什么等于确认**：对助手说「**确认执行**」。助手就用**完全相同的参数**、带上
`confirm=<planId>` 再调一次；一致才写盘。**这就是主流程，不需要任何界面**——
确认单是以纯文本回到会话里的（插件默认不在页面上显示任何东西）。

`confirm` 也可以给 **≥6 位的唯一前缀**（例如 `p_3f9a1c`）：只匹配到一份计划时接受，
匹配到多份会被要求补全，匹配不到按"不存在或已过期"处理。

**怎么改口**：直接说新的要求就行，例如"换第 4 页""颜色改成 #1050a0""输出改成 `/tmp/新名字.pdf`"。
参数一改，原来的计划 id 就作废（下次执行会被拒绝并告诉你哪里不一致），助手需要**重新生成计划**。

**`plan: true` 只想先看计划**：让助手带上 `plan: true` 调一次，只会返回确认单，不会写任何文件。
适合"先给我看流程，我看完再说"。

**有效期 15 分钟**：计划 15 分钟内有效、只能执行一次；取消了就不能再用。

**可选**：如果 profile 里把插件的 `surface` 设成 `true`，页面上会出现「PDF 工作台」浮层，
里面有一张「待确认操作」卡片可点「确认执行」/「取消」。卡片只改计划状态——点完仍要对助手说一句
「继续执行计划 …」才会真的执行。默认 `surface` 是关的，看不到浮层是正常的。

---

### 模板 13 · 批改：高亮一句话 + 盖个"已阅"

```
1) pdf_annotate path="作业.pdf" action=highlight page=2 find="解：设 x 为"
     color="#ffd400" opacity=0.4 output="/tmp/批改.pdf"
2) pdf_annotate path="/tmp/批改.pdf" action=stamp page=1
     rect={x:430,y:60,width:120,height:50} contents="已阅 10/10"
```

要点：文本标记用 `find` 就能定位，不需要自己算坐标；`rect` 的原点是**左下角**（页脚附近 y 很小）。

### 模板 14 · 加一条便签 / 写一段自由文本

```
pdf_annotate path="报告.pdf" action=note page=3 rect={x:520,y:760,width:24,height:24} contents="这里数据要复核"
pdf_annotate path="报告.pdf" action=freetext page=1 rect={x:60,y:700,width:220,height:30} contents="内部资料 请勿外传"
```

注意：`freetext` **不自动换行**，需要换行就在 `contents` 里写 `\n`；太长的文字会超出框宽（结果里会提示）。

### 模板 15 · 给整份材料编页码 + 页眉

```
pdf_text path="材料.pdf" action="page-number" pages="all" text="第 {page} / {total} 页"
  position="bottom-center" fontSize=9 output="/tmp/材料-带页码.pdf"

pdf_text path="/tmp/材料-带页码.pdf" action="header-footer" header="内部资料 · {date}"
  footer="第 {page} / {total} 页 · {filename}" output="/tmp/材料-定稿.pdf"
```

先页码后页眉可以，一次做完也行（`header-footer` 的 `footer` 就支持 `{page}/{total}`）。
`pages` 支持 `1-3,7`、`odd`、`even`。

### 模板 16 · 加 Bates 编号（卷宗/证据材料归档）

```
pdf_text path="卷宗.pdf" action="bates" pages="all" prefix="ABC-" digits=6 suffix="" start=1
  position="bottom-right" fontSize=8
```

编号按**选中顺序**递增：选 `2-4` 且 `start=7` → 第 2/3/4 页分别得到 `ABC-000007/8/9`。

### 模板 17 · 把 PDF 的几页导出成图片（放进 PPT / 发微信）

```
pdf_images path="报告.pdf" action="export" pages="1-3" format="png" scale=3 outputDir="/tmp/报告图"
```

要小体积就 `format="jpeg" quality=0.8`；要高清就 `scale=3`（≈216dpi）。
导出的是栅格化图片——文字不可搜索，别拿它当"可搜索版"。

### 模板 18 · 把一堆照片/扫描图合成一个 PDF

```
pdf_images action="build" images=["/tmp/1.jpg","/tmp/2.jpg","/tmp/3.png"]
  pageSize="a4" margin=24 output="/tmp/相册.pdf"
```

`images` 的**顺序就是页面顺序**；`pageSize="fit"` 时页面正好等于图片尺寸（不缩放）。

### 模板 19 · 填一份表单（Excel 导出的名单 → PDF 表单）

```
1) pdf_form path="报名表.pdf" action="list"          # 先看字段名与可选项
2) pdf_form path="报名表.pdf" action="fill"
     values={ "姓名": "张三", "同意条款": true, "性别": "Female", "城市": "Shanghai" }
     flatten=true output="/tmp/报名表-张三.pdf"
```

字段名必须与 `list` 给的**完全一致**（大小写、空格都算）；写错会报错并列出可用字段名。
要归档/发给别人就加 `flatten=true`（压平后不可再编辑）；还要留着继续填就别加。

### 模板 20 · 把 Letter 材料统一成 A4 / 拼版省纸 / 做小册子

```
# 统一成 A4（缩放，文字仍可搜索）
pdf_layout path="材料.pdf" action="resize" pageSize="a4" output="/tmp/材料-A4.pdf"

# 一张 A4 放 4 页（讲义/资料省纸）
pdf_layout path="材料.pdf" action="nup" perSheet=4 pageSize="a4" margin=12 gap=8 output="/tmp/材料-4up.pdf"

# 骑马钉小册子（打印后对折装订）
pdf_layout path="材料.pdf" action="booklet" pageSize="a4-landscape" output="/tmp/材料-小册子.pdf"
```

`resize` 是**缩放内容**（页面尺寸变了、内容跟着缩）；只想去掉白边/黑边请用 `pdf_crop`（只裁不缩）。
文件里有批注时，缩放/拼版不会同步处理它们，结果里会提示。

### 模板 21 · 对外发布前去掉作者/标题等隐私信息 + 加书签

```
pdf_metadata path="定稿.pdf" action="get"                     # 先看现在有什么
pdf_metadata path="定稿.pdf" action="set"
  values={ "title": "2026 届复习提纲", "author": "教务处" } output="/tmp/定稿-属性.pdf"
pdf_metadata path="/tmp/定稿-属性.pdf" action="outline-set"
  outline=[ {"title":"第一章 集合","page":1}, {"title":"第二章 函数","page":12} ]
  output="/tmp/定稿-书签.pdf"
# 彻底去隐私（作者/标题/时间都清掉）
pdf_metadata path="/tmp/定稿-书签.pdf" action="clear" output="/tmp/定稿-发布版.pdf"
```

书签支持**多层**（`outline` 的条目可带 `children`，最多 6 层；不写 children 就是扁平）；`{page}` 是**真实页号**。

### 模板 22 · 涂掉敏感信息（真删除，不是画黑框）

```
1) pdf_extract_text path="合同.pdf" page=3           # 拿到要涂那段的坐标
2) pdf_redact path="合同.pdf" action="preview"
     rects=[ {"page":3,"x":60,"y":700,"width":200,"height":20} ]
3) pdf_redact path="合同.pdf" action="apply"
     rects=[ {"page":3,"x":60,"y":700,"width":200,"height":20} ] output="/tmp/合同-脱密.pdf"
```

**必须先 preview 再 apply**：空跑会告诉你这条框能删掉几段文字。若工具**拒绝输出**并提示"仍能被提取出来"，
说明这页结构复杂（多段流/嵌套 XObject）——请改用
`pdf_images action=export` → 图片涂黑 → `pdf_images action=build` 重新合成，那是绝对可靠的路径。

### 模板 23 · 两版差异：改稿前后差在哪几页

```
pdf_optimize path="定稿v1.pdf" profile="compare" other="定稿v2.pdf"
```

输出会逐页列出新增/删除/改动，例如「第 1 页（有改动）+ 1 / 30」。
只读、不写盘。扫描件没有文字层时会明确说"无法按文字比对"。

### 模板 24 · 瘦身 / 线性化（以及目录批量）

```
pdf_optimize path="定稿.pdf" profile="gc" output="/tmp/定稿-优化.pdf"
pdf_optimize path="定稿.pdf" profile="linearize" output="/tmp/定稿-web.pdf"
```

**先看清楚结果里的字节数**：实测图片占主导的文档可能只省 ~2%，也可能不变甚至略增；
若没变小，就继续用源文件（不要为了"优化过"而用更大的文件）。
真正想大幅变小：`pdf_images action="export" format="jpeg" quality=0.8`（会栅格化，文字不可搜索）。

**目录批量**没有专门工具（批量是编排，不是 PDF 操作）：对每份文件依次调用
`pdf_layout`（统一尺寸）→ `pdf_text`（页码/页眉）→ `pdf_optimize`（瘦身）即可，
每一步都有确认单，逐个确认。

## 五、反例一览（以及为什么会返工）

| 这么说 | 会怎样 | 该怎么说 |
|---|---|---|
| "把这段涂黑就行" | 只画黑框是**假密文**：文字仍在内容流里，复制/提取照样拿得到 | 用 `pdf_redact`（真删），并先 `preview` 看能删几条 |
| "导出成图片但还要能搜索" | 导出必然是栅格化，文字变图片、搜索不到 | 要可搜索就保留 PDF（`pdf_make_searchable`），导出图片只用于展示 |
| "把第 2 页那句话高亮一下" | 只给 `find` 时只能按文字层定位（扫描件没有文字层会明确报错）；跨行只取第一行 | 说清页码 + 原句，或先 `pdf_make_searchable` |
| "把整页涂成黄色" | 文本标记只覆盖**匹配到的文字**，不会整页变黄 | 整页要的是 `box` + `rect`（或 `pdf_watermark`） |
| "把这个词改长一点" | `pdf_edit_text` 做不到不重叠：它只换字形串、**不移动后面的文字**（PDF 没有段落重排），改长就会压到下一个字上；引擎会提示"可能向右溢出"但不阻止 | 用 `pdf_replace_line`（整行重绘）：先 `runs=true` 拿到目标行任意一个 id，再用 `text="<这一整组的新文字>"` 重画；默认 `shiftSiblings: true` 会把同一视觉行右侧的片段整体右移让位（右侧组若是相对定位锚定则不平移并给重叠警告）。若这一组里还有别的文字，先确认是整组重写还是改回等长替换 |
| "帮我处理下这个 PDF" | 没有文件、动作、输出。助手只能猜，最坏的结果是"看起来成功"（改到了别的东西 / 什么也没改） | 按模板 1 先探，再按模板 2–7 挑一个 |
| "把里面那句话改一下" | `pdf_edit_text` 必须要 `edits[].targetId`，而 id 只能从 `runs=true` 里拿；不给页码和原文就无从下手 | "先 `runs=true` 列出文字块，我要改的是第 2 页那条「…」" |
| "把 300 页每一页的页脚都改成各自的日期" | 一次编辑只能用**同一份模型**里的 id，且改写后 id 会整体前移；跨编辑缓存 id 必然错位。整档 > 200 页还会命中歧义提示 | 分批做：一次读一页/一段，改完重新读模型再改下一批 |
| "加水印，要看不见但又删不掉" | 做不到。"不进入文字层"是 `render=outline`；"删不掉"取决于水印当初怎么被写进去——栅格化进页面图片、或当正文画的水印**无法可靠移除**，`scan` 只会有理有据地说不能删 | 明说优先级："只要能搜不到"（`render=outline`）或"只要能删"（先 `scan` 看候选） |
| "加个「机密」，文字你随便定" | 缺水印文字 = 缺关键参数，会返回一张写明缺什么的确认单；**带 `confirm` 也过不去**，因为执行只能退到插件默认值，等于替你瞎猜 | 给出 `text=<水印文字>` 或 `imagePath=<图片>` |
| "就用刚才那个 id 再改一处" | 改写后 id 会**整体前移**，旧 id 对应不上；一处都没应用时工具会**明确失败**（报"没有应用任何改写（0/N）"且不写盘），不会假装成功 | "先 `runs=true` 重读 id，再改这一处" |
| "把文件名改成 X" | 工具没有改名能力，只能"把结果写到 `output=X.pdf`" | "输出到 `<路径>/X.pdf`" |
| "随便找个地方存就行" | 不指定 `output` 时写到源文件旁的固定后缀名文件；同名文件已存在就会命中"覆盖"确认（覆盖前会先问你一次） | 明确写 `output=<路径>` |
| "先加密再解密，一起做" | 两个都是破坏性操作，各自要确认；而且解密的输入应该是**加密后的那个输出文件** | 分两步说，第二步的输入写清楚是上一步的输出 |
| "帮我智能拆分所有页面" | 没有"智能"。`pdf_split` 只会**严格按中线**（`gutter: middle`，默认）或按检测到的中缝切：低倍渲染后取左右内容框之间的间隔（≥ 8pt 才算找到），找不到就回退中线。它不理解"哪一半是答案、哪一半是空白"这类语义 | 说清版式与目标："这是左右两栏，左=答案右=空白，只要空白版 → `keep=right`"；或"缝不在正中，用 `gutter=auto`" |
| "把 A3 拆成 A4 打印" | 拆分**不缩放**，只改纸张边界：A3（420×297）切开正好是 A4（210×297），但 720×405 这类自定义尺寸切出来还是 360×405，**不是 A4**。工具只会在结果里提示"不是 A4"，不会自动缩到 A4（当前版本没有缩放/拼版能力） | 明确目标是"按版式对半切"还是"缩放到 A4"；后者当前不支持，先如实说明 |
| "帮我智能分离所有试卷的答案" | 没有"智能"。`pdf_find_answers` 只会**按页**打分给候选（页首标题词 / 连续递增的速查表 / 解答句 / 题干特征），**只在答案独立成页**时才能接着用 `pdf_arrange` 拆开。答案与题目同页（`mixed`）时它明确说"无法按页分离"，不会去擦题目、也不会裁半页；手写答案、多列答案表、半页答案可能判成 `无法判定`/`mixed` | 说清前提："先 `pdf_find_answers` 给候选与依据，答案单独成页就用它给的两条 `pdf_arrange` 命令拆；同页/判不出就人工确认页码，或只做'哪几页是答案'的报告" |

---

## 六、给助手（模型）的指令建议

把下面这段放进助手的系统提示或项目说明里：

```
处理 PDF 时：

1. 破坏性 / 高成本 / 有歧义的操作，必须在写盘前先拿到用户的确认：
   - 改写文字、整行重绘、删水印、加密、解密，以及"输出文件已存在会被覆盖"；
   - 页级装配（pdf_split 拆分 / pdf_crop 裁剪 / pdf_arrange 重排 / pdf_merge 合并）一律 destructive，
     必须先把确认单呈现给用户；确认单里若出现"不是 A4"的提示，要原样念给用户听（拆分不缩放）；
   - 没给水印文字/图片、没给裁剪 box、整档 > 200 页、一个名字对应多个文件；
   - pdf_inspect analyze=true、pdf_extract_text 整档且页数 > 20、pdf_make_searchable 页数 > 20
     （这三类高成本操作在默认策略下插件不会自动拦，所以你更要主动 `plan: true` 先把计划摆出来）。
   先不带 confirm 调一次拿到计划（或显式传 plan: true），把确认单原样呈现给用户，
   等用户说「确认执行」后，用**完全相同的参数**带上 confirm=<完整 planId> 再调一次。
   不要把 plan 里的 id 截断或改写；计划只存在当前进程的内存里（重启即清空）、15 分钟内有效、且只能执行一次。

2. 不要替用户猜文件名。候选多于一个就列出候选、要求指明具体路径；用户给的名字太模糊时，
   先把能找到的候选摆出来让他挑，不要自己选一个。

3. 缺参数就问，不要补默认值。例如没给水印文字，就不要用默认的 "WATERMARK" 顶上；
   先问"水印上写什么"。计划里出现 `默认值：…（你没指定，用了这些）` 时，把这些默认值念给用户听一遍。

4. 永远不要用 force: true。那是脚本与测试用的逃生舱，它会跳过包括"缺参数"在内的全部判定。
   用户说"别问了直接做"也不行——正确的做法是把确认单念清楚，让他说「确认执行」。

5. 改完自证：输出文件用 pdf_extract_text / pdf_inspect(runs=true) 回读一次，
   报告"哪一处变了、其余哪些没变、源文件字节没变"，不要把"已生成"当成验收。

6. 不要做没实现的事：改文件名、跨视觉行的整段重排、自动换行、去除栅格化水印，都不支持
   （同一视觉行的整行重绘 + 跨组重排由 `pdf_replace_line` 支持，默认 `shiftSiblings: true`）。
   页级装配也有边界：拆分**只改纸张边界、不缩放**（要 A4 可打印尺寸需要后续的缩放/拼版能力，
   当前没有 fit 参数）；拆分只支持 /Rotate 为 0 且长宽比 ≥ 1.25 的 2-up 版式；
   裁剪只裁不缩；重排只改顺序与 /Rotate、不改几何。
   遇到这类要求直接说明，不要绕。
```
