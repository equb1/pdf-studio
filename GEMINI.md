# 项目规则

## 1. 提交信息必须使用中文（最高优先级）

**所有 Git commit 的标题与正文一律使用中文。** 不要输出英文提交信息。

格式：`<type>(<scope>): <中文描述>`

```
feat(review): 新增可审查结果面板
fix: 修复文本提取解析异常
chore: 补充 .gitignore
```

适用场景包括但不限于：手动提交、以及任何"生成提交信息"（Generate Commit Message）功能自动生成的内容。

## 2. 其余规则

见 [`AGENTS.md`](./AGENTS.md) 与 [`.agents/rules/git.md`](./.agents/rules/git.md)。本文件与其内容重复时，以本文件为准。
