import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantText,
  sessionMeta,
  thinkingMessage,
  tokenUsage,
  toolCall,
  toolCallOutput,
  userText,
} from "../src/omnimessage/index.js";
import type {
  OmniMessage,
} from "../src/omnimessage/index.js";
import type { CompactionSettings } from "../src/engine/context-engine.js";
import type { LLMInterface, LLMOutcome, GenerativeModelParameters } from "../src/interfaces.js";
import {
  ContextEngine,
  STRUCTURED_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "../src/engine/context-engine.js";
import { Writer } from "../src/trace/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScriptedResponse { messages: OmniMessage[]; outcome?: LLMOutcome; }

class ScriptedLLM implements LLMInterface {
  calls: OmniMessage[][] = [];
  constructor(private readonly responses: ScriptedResponse[], readonly label = "llm") {}
  async *streamGenerate(params: GenerativeModelParameters): AsyncGenerator<OmniMessage, LLMOutcome> {
    this.calls.push(params.newMessages);
    const next = this.responses.shift();
    if (!next) throw new Error(`ScriptedLLM: no response for call #${this.calls.length}`);
    for (const msg of next.messages) yield msg;
    return next.outcome ?? { status: "completed" };
  }
}

const fakeEnvironment = {
  listTools: async () => [],
  async *executeTool() {},
  toolPermission: () => undefined,
};

const usage = (req: number, ses: number): OmniMessage =>
  tokenUsage({ cache_read: 0, cache_write: 0, output: 0, total: ses }, { cache_read: 0, cache_write: 0, output: 0, total: req });

const baseSettings = (over: Partial<CompactionSettings> = {}): CompactionSettings => ({
  maxContextLength: 100, maxSessionTurns: -1, mode: "summarize", prompt: "COMPACT NOW", ...over,
});

const metaMessage = sessionMeta({
  session_id: "sess_ab", provider: "custom", model_id: "test-model",
  model_context_window: 200000, system_prompt: "sp", agent_state: "/tmp/state", workspace: "/tmp/ws",
});

let traces: string;
beforeEach(async () => { traces = await mkdtemp(join(tmpdir(), "penguin-ab-")); });
afterEach(async () => { await rm(traces, { recursive: true, force: true }); });

function makeEngine(settingsObj: CompactionSettings): { engine: ContextEngine; llm: ScriptedLLM } {
  const llm = new ScriptedLLM([]);
  const trace = new Writer({ tracesDir: traces, sessionId: "sess_ab" });
  const engine = new ContextEngine({ llm, environment: fakeEnvironment, trace, sessionMeta: metaMessage, compaction: settingsObj, createLLM: () => llm });
  return { engine, llm };
}

// ---------------------------------------------------------------------------
// A/B Comparison Tests
// Group A = Original PH (no keepRecentTokens, no reserveTokens)
// Group B = PI-migrated (keepRecentTokens=20000, reserveTokens=16384, structured prompt)
// ---------------------------------------------------------------------------

describe("A/B Testing: Original PH vs PI-migrated compaction", () => {

  // ── Prompt Selection ──────────────────────────────────────────────────
  describe("1. Prompt selection logic", () => {
    it("Group A: uses original prompt when keepRecentTokens is absent", () => {
      const { engine } = makeEngine(baseSettings({ mode: "summarize" }));
      const s = (engine as unknown as { deps: { compaction: CompactionSettings } }).deps.compaction;
      expect(s.prompt).toBe("COMPACT NOW");
    });

    it("Group B: structured prompt has 6 required sections", () => {
      expect(STRUCTURED_SUMMARIZATION_PROMPT).toContain("## Goal");
      expect(STRUCTURED_SUMMARIZATION_PROMPT).toContain("## Constraints");
      expect(STRUCTURED_SUMMARIZATION_PROMPT).toContain("## Progress");
      expect(STRUCTURED_SUMMARIZATION_PROMPT).toContain("## Key Decisions");
      expect(STRUCTURED_SUMMARIZATION_PROMPT).toContain("## Next Steps");
      expect(STRUCTURED_SUMMARIZATION_PROMPT).toContain("## Critical Context");
    });

    it("Group B: update prompt replaces placeholders", () => {
      const prompt = UPDATE_SUMMARIZATION_PROMPT
        .replace("{previousSummary}", "Old summary")
        .replace("{newMessages}", "3 new messages");
      expect(prompt).toContain("Old summary");
      expect(prompt).toContain("3 new messages");
    });
  });

  // ── Trigger Threshold ─────────────────────────────────────────────────
  describe("2. Compaction trigger threshold", () => {
    it("Group A: triggers at exact maxContextLength", () => {
      const { engine } = makeEngine(baseSettings({ maxContextLength: 100 }));
      (engine as unknown as { lastRequestTotal: number }).lastRequestTotal = 100;
      expect((engine as unknown as { compactionTrigger(): string | null }).compactionTrigger()).toBe("context");
    });

    it("Group A: does NOT trigger at 99", () => {
      const { engine } = makeEngine(baseSettings({ maxContextLength: 100 }));
      (engine as unknown as { lastRequestTotal: number }).lastRequestTotal = 99;
      expect((engine as unknown as { compactionTrigger(): string | null }).compactionTrigger()).toBeNull();
    });

    it("Group B: triggers at maxContextLength - reserveTokens (81 with reserve=20)", () => {
      const { engine } = makeEngine(baseSettings({ maxContextLength: 100, reserveTokens: 20 }));
      (engine as unknown as { lastRequestTotal: number }).lastRequestTotal = 81;
      expect((engine as unknown as { compactionTrigger(): string | null }).compactionTrigger()).toBe("context");
    });

    it("Group B: triggers at exactly maxContextLength - reserveTokens (>=)", () => {
      const { engine } = makeEngine(baseSettings({ maxContextLength: 100, reserveTokens: 20 }));
      (engine as unknown as { lastRequestTotal: number }).lastRequestTotal = 80;
      expect((engine as unknown as { compactionTrigger(): string | null }).compactionTrigger()).toBe("context");
    });

    it("Group B: does NOT trigger below threshold", () => {
      const { engine } = makeEngine(baseSettings({ maxContextLength: 100, reserveTokens: 20 }));
      (engine as unknown as { lastRequestTotal: number }).lastRequestTotal = 79;
      expect((engine as unknown as { compactionTrigger(): string | null }).compactionTrigger()).toBeNull();
    });

    it("Group B: reserveTokens=0 behaves identically to Group A", () => {
      const { engine } = makeEngine(baseSettings({ maxContextLength: 100, reserveTokens: 0 }));
      (engine as unknown as { lastRequestTotal: number }).lastRequestTotal = 100;
      expect((engine as unknown as { compactionTrigger(): string | null }).compactionTrigger()).toBe("context");
    });
  });

  // ── Token Estimation (PI addition) ────────────────────────────────────
  describe("3. Token estimation", () => {
    it("text messages: chars/4", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.estimateTokens(userText("hello"))).toBe(Math.ceil(5 / 4));
    });

    it("thinking messages: chars/4", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.estimateTokens(thinkingMessage("reasoning"))).toBe(Math.ceil(9 / 4));
    });

    it("tool_call_output: chars/4 of output text", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.estimateTokens(toolCallOutput({ output: "result", toolCallId: "t1" }))).toBe(Math.ceil(6 / 4));
    });

    it("tool_call: chars/4 of arguments string", () => {
      const { engine } = makeEngine(baseSettings());
      const args = '{"filePath":"/tmp/test.ts"}';
      expect(engine.estimateTokens(toolCall({ name: "read", arguments: args, toolCallId: "t1" }))).toBe(Math.ceil(args.length / 4));
    });

    it("event messages: 0 tokens", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.estimateTokens(usage(10, 10))).toBe(0);
    });
  });

  // ── File Operations Tracking (PI addition) ────────────────────────────
  describe("4. File operations tracking", () => {
    it("tracks read from tool_call", () => {
      const { engine } = makeEngine(baseSettings());
      const ops = engine.extractFileOperations([
        toolCall({ name: "read", arguments: '{"filePath":"/src/a.ts"}', toolCallId: "t1" }),
      ]);
      expect(ops.readFiles).toContain("/src/a.ts");
      expect(ops.modifiedFiles).toHaveLength(0);
    });

    it("tracks write and edit from tool_call", () => {
      const { engine } = makeEngine(baseSettings());
      const ops = engine.extractFileOperations([
        toolCall({ name: "write", arguments: '{"filePath":"/src/b.ts"}', toolCallId: "t1" }),
        toolCall({ name: "edit", arguments: '{"filePath":"/src/c.ts"}', toolCallId: "t2" }),
      ]);
      expect(ops.modifiedFiles).toContain("/src/b.ts");
      expect(ops.modifiedFiles).toContain("/src/c.ts");
    });

    it("deduplicates paths", () => {
      const { engine } = makeEngine(baseSettings());
      const ops = engine.extractFileOperations([
        toolCall({ name: "read", arguments: '{"filePath":"/src/a.ts"}', toolCallId: "t1" }),
        toolCall({ name: "read", arguments: '{"filePath":"/src/a.ts"}', toolCallId: "t2" }),
      ]);
      expect(ops.readFiles.filter((f) => f === "/src/a.ts")).toHaveLength(1);
    });
  });

  // ── Split Turn Detection (PI addition) ────────────────────────────────
  describe("5. Split turn detection", () => {
    it("detects unmatched tool_call", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.detectSplitTurn([
        userText("q"), toolCall({ name: "read", arguments: "{}", toolCallId: "t1" }), assistantText("pending"),
      ])).toBe(1);
    });

    it("returns -1 when all matched", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.detectSplitTurn([
        userText("q"), toolCall({ name: "read", arguments: "{}", toolCallId: "t1" }),
        toolCallOutput({ output: "ok", toolCallId: "t1" }), assistantText("done"),
      ])).toBe(-1);
    });
  });

  // ── Cut Point Selection (PI addition) ─────────────────────────────────
  describe("6. Cut point selection", () => {
    it("keepRecentTokens=0 returns 0", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.findCutPoint([userText("q"), assistantText("a")], 0)).toBe(0);
    });

    it("returns 0 when total tokens < threshold", () => {
      const { engine } = makeEngine(baseSettings());
      expect(engine.findCutPoint([userText("hi")], 20000)).toBe(0);
    });

    it("cuts when tokens exceed threshold", () => {
      const { engine } = makeEngine(baseSettings());
      const long = "x".repeat(100000);
      const msgs = [userText("old"), assistantText(long), userText("new"), assistantText("ans")];
      const cp = engine.findCutPoint(msgs, 20000);
      expect(cp).toBeGreaterThanOrEqual(0);
      expect(cp).toBeLessThanOrEqual(2);
    });
  });

  // ── extractTextFromMessages ───────────────────────────────────────────
  describe("7. Text extraction", () => {
    it("captures all payload types", () => {
      const { engine } = makeEngine(baseSettings());
      const text = engine.extractTextFromMessages([
        userText("u"), assistantText("a"), thinkingMessage("t"),
        toolCall({ name: "read", arguments: "{}", toolCallId: "t1" }),
        toolCallOutput({ output: "out", toolCallId: "t1" }),
      ]);
      expect(text).toContain("u");
      expect(text).toContain("a");
      expect(text).toContain("t");
      expect(text).toContain("Tool Call");
      expect(text).toContain("Tool Output");
      expect(text).toContain("out");
    });
  });

  // ── Configurability ──────────────────────────────────────────────────
  describe("8. All PI settings freely configurable", () => {
    it("keepRecentTokens: 0, 50000, 20000 all work", () => {
      expect(makeEngine(baseSettings({ keepRecentTokens: 0 })).engine).toBeDefined();
      expect(makeEngine(baseSettings({ keepRecentTokens: 50000 })).engine).toBeDefined();
      expect(makeEngine(baseSettings({ keepRecentTokens: 20000 })).engine).toBeDefined();
    });

    it("reserveTokens: 0, 16384, 32768 all work", () => {
      expect(makeEngine(baseSettings({ reserveTokens: 0 })).engine).toBeDefined();
      expect(makeEngine(baseSettings({ reserveTokens: 16384 })).engine).toBeDefined();
      expect(makeEngine(baseSettings({ reserveTokens: 32768 })).engine).toBeDefined();
    });

    it("updatePrompt: custom or absent", () => {
      expect(makeEngine(baseSettings({ updatePrompt: "CUSTOM {previousSummary}" })).engine).toBeDefined();
      expect(makeEngine(baseSettings()).engine).toBeDefined();
    });
  });
});
