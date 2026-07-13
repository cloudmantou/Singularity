import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  formatTranscript,
  readProjectContext,
} = require("../../integrations/claude-code-hooks/context.cjs") as {
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
  });

  it("clips from the oldest side so the latest decisions survive", () => {
    const result = formatTranscript([
      { role: "user", content: "old context that can be removed" },
      { role: "assistant", content: "latest decision" },
    ], 32);
    expect(result).toContain("latest decision");
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it("derives the repository and branch from the current worktree", () => {
    const context = readProjectContext(process.cwd());
    expect(context.repository).toBe("second-brain-cloudflare");
    expect(context.branch).toBeTruthy();
  });
});
