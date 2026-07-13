import { describe, expect, it } from "vitest";
import {
  sanitizeObsidianContent,
  sanitizeObsidianGeneratedText,
} from "../../src/index";

describe("Obsidian generated output safety", () => {
  it("forces generated facts to one escaped text line", () => {
    const value = sanitizeObsidianGeneratedText("fact\n## injected <script>alert(1)</script>");
    expect(value).not.toContain("\n");
    expect(value).not.toContain("<script>");
    expect(value).toContain("&lt;script&gt;");
    expect(value).toContain("\\#\\# injected");
  });

  it("removes Obsidian link control characters from entity targets", () => {
    expect(sanitizeObsidianGeneratedText("bad|alias#[block]\nnext", "wikilink"))
      .toBe("badaliasblock next");
  });

  it("removes the managed knowledge projection before evidence hashing", () => {
    const content = `---
managed_by: singularity
---
User-authored source text.

<!-- SINGULARITY:KNOWLEDGE:BEGIN -->
## 关联实体
- [[Singularity]]

## 事实解析
- generated fact [supports]
<!-- SINGULARITY:KNOWLEDGE:END -->`;

    expect(sanitizeObsidianContent(content, { managed_by: "singularity" }))
      .toBe("User-authored source text.");
  });
});
