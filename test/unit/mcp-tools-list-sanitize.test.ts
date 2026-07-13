import { describe, expect, it } from "vitest";
import {
  isMcpToolsListRequest,
  removeToolExecutionMetadata,
  sanitizeToolsListResponse,
} from "../../src/mcp/tools-list-sanitize";

const payload = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [{
      name: "recall",
      inputSchema: { type: "object" },
      execution: { taskSupport: "optional" },
    }],
  },
};

describe("MCP tools/list compatibility", () => {
  it("detects tools/list without consuming the original request", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const request = new Request("https://example.com/mcp", { method: "POST", body });
    expect(await isMcpToolsListRequest(request)).toBe(true);
    expect(await request.text()).toBe(body);
  });

  it("immutably strips unsupported execution metadata", () => {
    const sanitized = removeToolExecutionMetadata(payload) as typeof payload;
    expect(sanitized.result.tools[0]).not.toHaveProperty("execution");
    expect(payload.result.tools[0]).toHaveProperty("execution");
  });

  it("sanitizes JSON and SSE responses while preserving headers", async () => {
    const jsonResponse = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "content-length": "10",
        "mcp-session-id": "abc",
      },
    });
    const cleanJson = await sanitizeToolsListResponse(jsonResponse);
    expect((await cleanJson.json() as any).result.tools[0].execution).toBeUndefined();
    expect(cleanJson.headers.get("content-length")).toBeNull();
    expect(cleanJson.headers.get("mcp-session-id")).toBe("abc");

    const sseResponse = new Response(`data: ${JSON.stringify(payload)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    const cleanSse = await sanitizeToolsListResponse(sseResponse);
    expect(await cleanSse.text()).not.toContain("execution");
  });
});
