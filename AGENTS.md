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

