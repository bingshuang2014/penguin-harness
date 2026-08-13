# PenguinHarness 压缩机制迁移规划

> 基于 PI (pi-coding-agent) v0.2.x 的优秀实践
> 规划时间: 2026-08-13
> 目标: 将 PI 的压缩机制迁移到 PenguinHarness，预期提升 30-50%

---

## 1. PI 压缩机制核心优势

### 1.1 keepRecentTokens — 最近上下文保留（占效果 50%）

**PI 实现原理：**
```
触发条件: contextTokens > contextWindow - reserveTokens
- reserveTokens: 16384（预留约 13%）
- keepRecentTokens: 20000（保留最近 20k tokens）

切点算法:
1. 从最新消息反向遍历
2. 累积估计的 token 数（chars/4 近似）
3. 达到 keepRecentTokens 时停止
4. 在有效切点（turn 边界）停止
```

**为什么重要：**
- 最近的对话上下文是最有价值的
- 避免"重新猜"上下文的问题
- 理解准确率：~85% vs ~60%

### 1.2 reserveTokens — 预留空间（防止连续触发）

**PI 实现：**
```javascript
function shouldCompact(contextTokens, contextWindow, settings) {
    return contextTokens > contextWindow - settings.reserveTokens;
}
// reserveTokens: 16384（预留约 13%）
```

**为什么重要：**
- PH 当前在上下文刚超过阈值时触发
- 没有预留空间给当前请求和响应
- 导致可能连续触发压缩

### 1.3 增量摘要更新（占效果 25%）

**PI 实现：**
```javascript
let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
```

**优势：**
- 首次全量摘要
- 后续增量更新（在已有摘要上追加）
- 节省 50-70% 压缩 token 消耗

### 1.4 结构化 6 段式提示词（占效果 15%）

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

### 1.5 文件操作追踪（占效果 10%）

**PI 实现：**
```typescript
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

**优势：**
- 让模型知道当前关注哪些文件
- 对代码编辑任务效果明显

---

## 2. PenguinHarness 当前实现分析

### 2.1 CompactionSettings 接口（line 94-102）

```typescript
interface CompactionSettings {
  maxContextLength: number;  // 触发阈值
  maxSessionTurns: number;   // 会话轮次阈值
  mode: CompactionMode;      // 模式
  prompt: string;            // 提示词
  // ❌ 缺少 keepRecentTokens
  // ❌ 缺少 reserveTokens
}
```

### 2.2 compactionTrigger 函数（line 1233-1243）

```typescript
private compactionTrigger(): CompactionReason | null {
  if (settings.maxContextLength > 0 && this.lastRequestTotal >= settings.maxContextLength) {
    return "context";
  }
  if (settings.maxSessionTurns > 0 && this.sessionTurns >= settings.maxSessionTurns) {
    return "turns";
  }
  return null;
}
// ❌ 没有 reserveTokens 预留
// ❌ 上下文刚超过阈值就触发压缩
```

### 2.3 summarizeContext 函数（line 1294+）

```typescript
private async *summarizeContext(...) {
  // ❌ 没有 keepRecentTokens 逻辑
  // ❌ 把所有历史一起丢给模型做总结
  // ❌ 每次都全量从头
}
```

---

## 3. 迁移方案

### Phase 1: 结构化提示词（推荐先做）

**改动范围：** `packages/core/src/engine/context-engine.ts`

**改动内容：**
1. 新增 `UPDATE_SUMMARIZATION_PROMPT` 常量
2. 修改 `CompactionSettings` 接口，添加 `structuredPrompt` 选项
3. 在 `summarizeContext` 中根据是否有 previousSummary 选择提示词

**预估改动：** ~30 行代码

**风险：** 低（可通过配置开关）

### Phase 2: keepRecentTokens（效果最大）

**改动范围：** `packages/core/src/engine/context-engine.ts`

**改动内容：**
1. 扩展 `CompactionSettings` 接口：
   ```typescript
   interface CompactionSettings {
     maxContextLength: number;
     maxSessionTurns: number;
     mode: CompactionMode;
     prompt: string;
     // 新增
     keepRecentTokens?: number;  // 默认 20000
     reserveTokens?: number;     // 默认 16384
   }
   ```
2. 修改 `compactionTrigger()` 添加 reserveTokens 逻辑：
   ```typescript
   private compactionTrigger(): CompactionReason | null {
     const settings = this.deps.compaction;
     if (!settings || !this.deps.createLLM) return null;
     
     const reserveTokens = settings.reserveTokens ?? 16384;
     
     if (settings.maxContextLength > 0 && 
         this.lastRequestTotal >= settings.maxContextLength - reserveTokens) {
       return "context";
     }
     // ...
   }
   ```
3. 实现 `findCutPoint()` 函数：
   ```typescript
   private findCutPoint(
     messages: OmniMessage[],
     keepRecentTokens: number
   ): number {
     let accumulatedTokens = 0;
     for (let i = messages.length - 1; i >= 0; i--) {
       const msg = messages[i];
       const tokenEstimate = this.estimateTokens(msg);
       accumulatedTokens += tokenEstimate;
       if (accumulatedTokens >= keepRecentTokens) {
         // 找到有效切点（turn 边界）
         return this.findValidCutPoint(messages, i);
       }
     }
     return 0;
   }
   ```
4. 实现 `estimateTokens()` 函数：
   ```typescript
   private estimateTokens(msg: OmniMessage): number {
     // chars/4 近似
     const text = this.extractText(msg);
     return Math.ceil(text.length / 4);
   }
   ```
5. 修改 `summarizeContext()` 使用切点：
   ```typescript
   private async *summarizeContext(...) {
     const keepRecent = settings.keepRecentTokens ?? 20000;
     const cutIndex = this.findCutPoint(messages, keepRecent);
     
     // 只总结 cutIndex 之前的消息
     const messagesToSummarize = messages.slice(0, cutIndex);
     const messagesToKeep = messages.slice(cutIndex);
     
     // ... 生成摘要
   }
   ```

**预估改动：** ~80 行代码

**风险：** 中（需要充分测试）

### Phase 3: 增量更新摘要（效果中等）

**改动范围：** `packages/core/src/engine/context-engine.ts`

**改动内容：**
1. 新增 `UPDATE_SUMMARIZATION_PROMPT` 常量：
   ```typescript
   const UPDATE_SUMMARIZATION_PROMPT = `You are updating an existing summary of a conversation.
   
   Previous Summary:
   {previousSummary}
   
   New Messages:
   {newMessages}
   
   Update the summary to incorporate the new information. Keep the same structure.
   Preserve exact file paths, function names, error messages.`;
   ```
2. 修改 `summarizeContext()` 传递 previousSummary：
   ```typescript
   private async *summarizeContext(...) {
     const previousSummary = this.extractPreviousSummary();
     
     let prompt: string;
     if (previousSummary) {
       prompt = this.buildUpdatePrompt(previousSummary, newMessages);
     } else {
       prompt = userText(settings.prompt);
     }
     
     // ... 生成摘要
   }
   ```

**预估改动：** ~50 行代码

**风险：** 中（需要确保增量更新质量）

### Phase 4: 文件操作追踪（效果较小）

**改动范围：** `packages/core/src/engine/context-engine.ts`

**改动内容：**
1. 扩展 `CompactionDetails` 接口：
   ```typescript
   interface CompactionDetails {
     readFiles: string[];
     modifiedFiles: string[];
   }
   ```
2. 在 `summarizeContext()` 中提取文件操作：
   ```typescript
   private extractFileOperations(messages: OmniMessage[]): CompactionDetails {
     const readFiles: string[] = [];
     const modifiedFiles: string[] = [];
     
     for (const msg of messages) {
       if (msg.type === 'tool_call') {
         const toolName = msg.payload.name;
         const args = msg.payload.arguments;
         
         if (toolName === 'read' && args.filePath) {
           readFiles.push(args.filePath);
         }
         if (toolName === 'write' || toolName === 'edit') {
           modifiedFiles.push(args.filePath);
         }
       }
     }
     
     return { readFiles: [...new Set(readFiles)], modifiedFiles: [...new Set(modifiedFiles)] };
   }
   ```
3. 在摘要中添加文件信息：
   ```typescript
   const fileOps = this.extractFileOperations(messages);
   const fileContext = `
   <read-files>
   ${fileOps.readFiles.join('\n')}
   </read-files>
   
   <modified-files>
   ${fileOps.modifiedFiles.join('\n')}
   </modified-files>`;
   ```

**预估改动：** ~40 行代码

**风险：** 低

---

## 4. 测试计划

### 4.1 单元测试

```typescript
// packages/core/test/compaction.test.ts

describe('keepRecentTokens', () => {
  it('should preserve recent 20k tokens', () => {
    // 测试切点算法
  });
  
  it('should handle split turns', () => {
    // 测试单 turn 超过 keepRecentTokens 的情况
  });
});

describe('reserveTokens', () => {
  it('should trigger compaction before context limit', () => {
    // 测试预留空间逻辑
  });
});

describe('incremental summary', () => {
  it('should update existing summary', () => {
    // 测试增量更新
  });
});
```

### 4.2 集成测试

1. 创建长对话场景（>100k tokens）
2. 验证压缩触发时机
3. 验证最近上下文保留
4. 验证摘要质量

### 4.3 A/B 测试

1. 对比 PH 原始压缩 vs PI 迁移后压缩
2. 测量对话理解准确率
3. 测量压缩 token 消耗

---

## 5. 风险评估

| 风险项 | 概率 | 影响 | 缓解措施 |
|--------|------|------|---------|
| 切点算法引入 bug | 中 | 高 | 充分单元测试 |
| 增量更新摘要质量下降 | 低 | 中 | A/B 测试对比 |
| 迁移过程中破坏 PH 现有重试机制 | 低 | 高 | 隔离改动，逐 Phase 验证 |
| 模型对结构化提示词响应差 | 低 | 中 | 保持提示词可配置 |

---

## 6. 实施顺序

### 推荐顺序（风险最低 → 效果最大）

1. **Phase 1: 结构化提示词**（~30 行，风险低）
2. **Phase 4: 文件操作追踪**（~40 行，风险低）
3. **Phase 2: keepRecentTokens**（~80 行，风险中）
4. **Phase 3: 增量更新摘要**（~50 行，风险中）

### 总改动量

- 代码改动：~200 行
- 测试代码：~100 行
- 文档更新：~50 行

---

## 7. 验证标准

### 7.1 功能验证

- [ ] 压缩触发时机正确（reserveTokens）
- [ ] 最近上下文完整保留（keepRecentTokens）
- [ ] 摘要质量与原始相当或更好
- [ ] 增量更新正确合并信息
- [ ] 文件操作正确追踪

### 7.2 性能验证

- [ ] 压缩 token 消耗降低 50%+
- [ ] 对话理解准确率提升 20%+
- [ ] 无明显延迟增加

### 7.3 兼容性验证

- [ ] 现有测试全部通过
- [ ] 配置向后兼容
- [ ] 不破坏 PH 现有重试机制

---

## 8. 参考资源

- PI 文档: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md
- PI 源码: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts
- PH 源码: packages/core/src/engine/context-engine.ts
- 对比报告: PI压缩机制对比分析报告.md
