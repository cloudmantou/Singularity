import { createRequire } from "node:module";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  extractTranscriptMessages,
  formatTranscript,
  readProjectContext,
} = require("../../integrations/claude-code-hooks/context.cjs") as {
  extractTranscriptMessages(messages: unknown[], maxChars?: number): Array<{
    role: "user" | "assistant";
    content: string;
    messageId?: string;
  }>;
  formatTranscript(messages: unknown[], maxChars?: number): string;
  readProjectContext(cwd?: string): { repository: string; branch: string; root: string };
};

describe("development session hook context", () => {
  it("preserves user/assistant roles and ignores tool-only payloads", () => {
    expect(formatTranscript([
      { role: "user", content: "Keep Evidence immutable" },
      { role: "tool", content: "secret tool output" },
      { role: "assistant", content: [{ type: "text", text: "Use Association for navigation" }] },
    ])).toBe(
      "User: Keep Evidence immutable\n\nAssistant: Use Association for navigation"
    );
    expect(extractTranscriptMessages([
      { role: "user", content: "Decision", uuid: "message-1" },
      { role: "assistant", content: "Summary" },
    ])).toEqual([
      { role: "user", content: "Decision", messageId: "message-1" },
      { role: "assistant", content: "Summary" },
    ]);
  });

  it("clips from the oldest side so the latest decisions survive", () => {
    const result = formatTranscript([
      { role: "user", content: "old context that can be removed" },
      { role: "assistant", content: "latest decision" },
    ], 32);
    expect(result).toContain("latest decision");
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it("never submits a truncated fragment of an oversized message", () => {
    expect(extractTranscriptMessages([
      { role: "user", content: "Do not treat the trailing clause as a standalone decision." },
    ], 24)).toEqual([]);
  });

  it("derives the repository and branch from the current worktree", () => {
    const context = readProjectContext(process.cwd());
    expect(context.repository).toBe(basename(context.root));
    expect(context.branch).toBeTruthy();
  });
});
