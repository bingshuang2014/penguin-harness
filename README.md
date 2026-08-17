# Penguin Core Fork 改造说明

## 仓库信息

- **Fork 仓库**：`git@github.com:bingshuang2014/penguin-harness.git`
- **分支**：`feat/pi-compaction-improvements`
- **原版仓库**：`https://github.com/Prism-Shadow/penguin-harness.git`

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

#### Bug 3: `pendingRecentMessages` 被内部覆盖

**问题**：`summarizeContext` 内部再次调用 `findCutPoint` 并覆盖 `pendingRecentMessages`，导致外部设置的正确值被丢弃。

**根因分析**：
1. 外部设置 `this.pendingRecentMessages = attemptInput.slice(cutPoint)`（正确）
2. `summarizeContext` 内部设置 `this.pendingRecentMessages = recentToKeep`（错误覆盖）
3. `recentToKeep` 来自早期消息的切分，而不是完整上下文的切分

**修复**：删除 `summarizeContext` 内部的覆盖逻辑，使用外部已正确设置的值。

```typescript
// 修复前：内部又计算了一次，覆盖了外部设置
let recentToKeep: OmniMessage[] = [];
if (useStructuredPrompt && keepRecentTokens > 0 && pendingToolOutputs.length > 0) {
  const cutPoint = this.findCutPoint(pendingToolOutputs, keepRecentTokens);
  if (cutPoint > 0 && cutPoint < pendingToolOutputs.length) {
    recentToKeep = pendingToolOutputs.slice(cutPoint);  // ❌ 覆盖外部设置
  }
}
this.pendingRecentMessages = recentToKeep;

// 修复后：不覆盖，使用外部已设置的值
// Don't overwrite pendingRecentMessages here - it's already correctly set
// by the caller (external compaction entry) with the proper cut point from
// the full context.
```

## 教训

### 修改外部逻辑时，必须检查被调用函数的内部实现

**错误做法**：只看调用点，假设被调用函数不会修改状态。

**正确做法**：
1. 阅读被调用函数的完整实现
2. 检查它是否会覆盖我设置的状态
3. 确保修改不会被内部逻辑覆盖

**典型场景**：
- 外部设置状态 → 被调用函数内部覆盖
- 外部计算结果 → 被调用函数重新计算
- 外部传递参数 → 被调用函数忽略或修改

**检查清单**：
- [ ] 被调用函数是否修改了我设置的状态？
- [ ] 被调用函数是否重新计算了我传递的结果？
- [ ] 是否需要同步修改被调用函数的内部逻辑？

## 与原版的区别

| 对比项 | 原版 (Prism-Shadow) | 我们的 Fork |
|--------|---------------------|-------------|
| **keep_recent_tokens** | 只对当前轮 toolOutputs 生效 | 对完整上下文生效 |
| **CJK token 估算** | `text.length / 4`（中文低估 75%） | CJK 感知：中文 ~1 token/字符 |
| **pendingRecentMessages** | summarizeContext 内部覆盖 | 外部设置，内部不再覆盖 |
| **配置项** | 仅 max_context_length, mode 等基础配置 | 新增 keep_recent_tokens, reserve_tokens, update_prompt |
| **测试用例** | 53 个 compaction 测试 | 56 个（+3 个中文测试） |
| **支持语言** | 仅英文场景 | 中英文混合场景优化 |

### 代码差异概览

```
packages/core/src/engine/context-engine.ts  (~30 行改动)
├─ Bug 1: 外部计算 cutPoint，传入 summarizeContext
├─ Bug 2: 新增 estimateTokensFromText() + isCjkCharacter()
└─ Bug 3: 删除 summarizeContext 内部 pendingRecentMessages 覆盖

packages/core/src/state/default-config.ts  (~6 行)
└─ 新增 CompactionConfig 接口字段

packages/core/src/agent.ts  (~3 行)
└─ 读取 keep_recent_tokens/reserve_tokens/update_prompt

packages/core/test/compaction.test.ts  (~50 行)
└─ 新增 CJK token 估算测试用例
```

## 验证

```bash
cd penguin-harness/packages/core
npm test -- --run test/compaction.test.ts
```

所有 56 个 compaction 测试通过（原版 53 个 + 新增 3 个中文测试）。

## 生成时间

2026-08-17
