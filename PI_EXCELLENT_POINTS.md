# PI 压缩机制优秀点总结

> 基于 PI (pi-coding-agent) v0.2.x 的压缩机制分析
> 整理时间: 2026-08-13

---

## 🎯 核心优秀点

### 1. keepRecentTokens — 最近上下文保留

**PI 实现：**
```javascript
// 从最新消息反向遍历，保留最近 20k tokens
function findCutPoint(entries, startIndex, endIndex, keepRecentTokens) {
    let accumulatedTokens = 0;
    for (let i = endIndex - 1; i >= startIndex; i--) {
        const messageTokens = estimateTokens(message); // chars/4 近似
        accumulatedTokens += messageTokens;
        if (accumulatedTokens >= keepRecentTokens) {
            break;
        }
    }
    return cutIndex;
}
```

**为什么优秀：**
- ✅ 最近的对话上下文是最有价值的
- ✅ 避免"重新猜"上下文的问题
- ✅ 理解准确率：~85% vs ~60%
- ✅ 代码编辑场景效果尤其明显

---

### 2. reserveTokens — 预留空间

**PI 实现：**
```javascript
function shouldCompact(contextTokens, contextWindow, settings) {
    return contextTokens > contextWindow - settings.reserveTokens;
}
// reserveTokens: 16384（预留约 13%）
```

**为什么优秀：**
- ✅ 防止上下文刚超过阈值就触发压缩
- ✅ 为当前请求和响应预留空间
- ✅ 避免连续触发压缩

---

### 3. 增量摘要更新

**PI 实现：**
```javascript
let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
```

**为什么优秀：**
- ✅ 首次全量摘要
- ✅ 后续增量更新（在已有摘要上追加）
- ✅ 节省 50-70% 压缩 token 消耗
- ✅ 避免多次压缩中丢失信息

---

### 4. 结构化 6 段式提示词

**PI 提示词格式：**
```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

**为什么优秀：**
- ✅ 确保关键信息不被遗漏
- ✅ 模型按固定结构输出
- ✅ 明确要求保留文件路径、函数名、错误信息

---

### 5. 文件操作追踪

**PI 实现：**
```typescript
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

**为什么优秀：**
- ✅ 让模型知道当前关注哪些文件
- ✅ 对代码编辑任务效果明显
- ✅ 跨压缩累积追踪

---

### 6. Split Turns 处理

**PI 实现：**
```
当单个 turn 超过 keepRecentTokens 时：
- 切点落在 turn 中间的 assistant 消息
- 自动检测 split turn
- 单独总结 turn 前缀
```

**为什么优秀：**
- ✅ 处理边界情况
- ✅ 避免丢失大 turn 的上下文
- ✅ 保持 tool_use/tool_result 配对

---

## 📊 效果对比

| 维度 | PI | PenguinHarness | 差距 |
|------|-----|----------------|------|
| 最近上下文保留 | ✅ keepRecentTokens: 20k | ❌ 无 | **核心差距** |
| 摘要更新模式 | 首次全量 + 增量更新 | 每次都全量从头 | 显著差距 |
| 提示词结构 | 结构化 6 段式 | 自由文本格式 | 中等差距 |
| 文件操作追踪 | read-files / modified-files | ❌ 无 | 轻微差距 |
| 压缩失败重试 | 无独立重试机制 | ✅ SUMMARY_RETRY_GUIDANCE | PH 更优 |
| 丢弃模式 | 无 | ✅ discardContext | PH 更优 |

---

## 🎯 迁移优先级

### 优先级 1: keepRecentTokens（占效果 50%）

**为什么最重要：**
- 最近的对话上下文是最有价值的
- 避免"重新猜"上下文的问题
- 理解准确率提升 25%+

**实现要点：**
1. 反向遍历消息
2. 累积 token 估计（chars/4）
3. 达到 keepRecentTokens 时停止
4. 在有效切点（turn 边界）停止

---

### 优先级 2: 增量更新摘要（占效果 25%）

**为什么重要：**
- 节省 50-70% 压缩 token 消耗
- 避免多次压缩中丢失信息
- 模型理解成本更低

**实现要点：**
1. 检测是否有 previousSummary
2. 使用 UPDATE_SUMMARIZATION_PROMPT
3. 在已有摘要上追加新信息

---

### 优先级 3: 结构化提示词（占效果 15%）

**为什么重要：**
- 确保关键信息不被遗漏
- 模型按固定结构输出
- 明确保留文件路径、函数名、错误信息

**实现要点：**
1. 定义 6 段式格式
2. 要求 Preserve exact file paths, function names, error messages
3. 保持提示词可配置

---

### 优先级 4: 文件操作追踪（占效果 10%）

**为什么重要：**
- 让模型知道当前关注哪些文件
- 对代码编辑任务效果明显

**实现要点：**
1. 从 tool_call 中提取文件操作
2. 累积追踪 readFiles 和 modifiedFiles
3. 在摘要中添加文件信息

---

## 📝 实施建议

### 最小改动方案

**Phase 1 + Phase 2：**
- 改动范围：~130 行
- 预期效果：25-30% 整体提升
- 风险：低-中

### 最大效果方案

**Phase 1 + 2 + 3 + 4：**
- 改动范围：~200 行
- 预期效果：30-50% 整体提升
- 风险：中

---

## 🔗 参考资源

- PI 官方文档: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md
- PI 源码: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts
- 对比报告: PI压缩机制对比分析报告.md
- 迁移规划: MIGRATION_PLAN.md
