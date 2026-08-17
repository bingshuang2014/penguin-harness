# Penguin Core Fork 改造说明

## 改造目标

基于 penguin-core 原版，修复 PI Compaction（上下文压缩）功能的关键 bug，提升中文场景下的压缩准确性。

## 改造内容

### 1. 配置项支持

在 `system_config.yaml` 中支持以下 compaction 配置：

```yaml
compaction:
  max_context_length: 128000      # 上下文 token 阈值
  max_session_turns: -1           # 会话轮次阈值（-1 无限制）
  mode: summarize                 # 压缩模式：summarize / discard
  keep_recent_tokens: 20000       # 保留最近 20k tokens
  reserve_tokens: 16384           # 保留缓冲区 tokens
  update_prompt: null             # 增量摘要提示词
```

### 2. 核心 Bug 修复

#### Bug 1: `keep_recent_tokens` 不生效

**问题**：原版 `keep_recent_tokens` 只对当前轮的 `turn.toolOutputs` 生效，而不是完整上下文。

**修复**：在调用 `summarizeContext` 之前，先在 `attemptInput`（完整上下文）上计算切分点。

```typescript
// 修复前：只处理当前轮 tool outputs
const result = yield* this.summarizeContext(
  compactionReason,
  midTask ? turn.toolOutputs : [],  // ❌ 只有当前轮
  signal,
);

// 修复后：处理完整上下文
const cutPoint = this.findCutPoint(attemptInput, keepRecentTokens);
if (cutPoint > 0 && cutPoint < attemptInput.length) {
  pendingToolOutputsForCompaction = attemptInput.slice(0, cutPoint);  // 需要压缩的
  this.pendingRecentMessages = attemptInput.slice(cutPoint);          // 保留的
}
const result = yield* this.summarizeContext(
  compactionReason,
  pendingToolOutputsForCompaction,  // ✅ 完整上下文
  signal,
);
```

#### Bug 2: Token 估算中文偏差

**问题**：原版使用 `text.length / 4` 估算所有字符，中文字符约 1 字符/token，导致混合中文文本被严重低估（偏差 75%）。

**修复**：实现 CJK 感知的 token 估算。

```typescript
// 修复前
return Math.ceil(text.length / 4);  // ❌ 中文被低估

// 修复后
private estimateTokensFromText(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (this.isCjkCharacter(code)) {
      cjkCount++;     // 中文字符 ~1 token
    } else {
      otherCount++;   // 英文字符 ~4 chars/token
    }
  }
  return Math.ceil(cjkCount + otherCount / 4);  // ✅ CJK 感知
}
```

## 修改文件

| 文件 | 修改内容 |
|------|----------|
| `packages/core/src/agent.ts` | 添加 keepRecentTokens/reserveTokens/updatePrompt 配置读取 |
| `packages/core/src/engine/context-engine.ts` | 核心修复：keep_recent_tokens + CJK token 估算 |
| `packages/core/src/state/default-config.ts` | 添加配置项类型定义 |
| `packages/core/test/compaction.test.ts` | 新增中文测试用例 |

## 验证

```bash
cd penguin-harness/packages/core
npm test -- --run test/compaction.test.ts
```

所有 56 个 compaction 测试通过（原版 53 个 + 新增 3 个中文测试）。

## 生成时间

2026-08-17
