# Git 提交规范

1. **语言要求**：
   - 所有的 Git Commit 标题与描述信息必须统一使用**中文**。

2. **提交格式**：
   - 遵循 Conventional Commits 格式规范：`<type>(<scope>): <中文描述>`（scope 可选）。
   - 常用类型（type）：
     - `feat`: 新增功能
     - `fix`: 修复 bug
     - `docs`: 文档更新
     - `style`: 代码格式调整（不影响逻辑）
     - `refactor`: 重构代码（既不修复 bug 也不添加新功能）
     - `perf`: 性能优化
     - `test`: 增加或修改测试
     - `chore`: 构建过程、辅助工具及依赖库变动
     - `revert`: 回滚某次提交

3. **示例**：
   - `feat(review): 新增可审查结果面板组件与页面挂载`
   - `fix(text-layer): 修复 PDF 文本图层提取时的坐标偏移问题`
   - `chore: 添加 .gitignore 并配置构建产物与依赖忽略规则`
