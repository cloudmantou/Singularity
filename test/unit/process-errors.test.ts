import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import {
  classifyUnhandledRejection,
  formatUnknownReason,
  getRuntimeRejectionContext,
  handleUnhandledRejection,
  runMcpRequest,
  runWithRuntimeRejectionContext,
} from "../../src/selfhost/process-errors";
import { createExecutionContext } from "../../src/selfhost/env";

const execFileAsync = promisify(execFile);

describe("classifyUnhandledRejection", () => {
  it("ignores empty rejections only inside an MCP request context", () => {
    const context = { source: "mcp" as const, requestId: "req-20" };

    expect(classifyUnhandledRejection(null, context)).toBe("ignore-empty");
    expect(classifyUnhandledRejection(undefined, context)).toBe("ignore-empty");
    expect(classifyUnhandledRejection(null)).toBe("fatal");
    expect(classifyUnhandledRejection(undefined)).toBe("fatal");
  });

  it("ignores only explicit connection-close failures", () => {
    expect(
      classifyUnhandledRejection(
        Object.assign(new Error("reset"), { code: "ECONNRESET" })
      )
    ).toBe("ignore-disconnect");
    expect(
      classifyUnhandledRejection(
        Object.assign(new Error("cancelled"), { code: "ECANCELED" })
      )
    ).toBe("ignore-disconnect");
  });

  it("keeps real unknown failures fatal", () => {
    expect(classifyUnhandledRejection(new Error("database corrupted"))).toBe(
      "fatal"
    );
    expect(classifyUnhandledRejection("unexpected rejection")).toBe("fatal");
  });
});

describe("formatUnknownReason", () => {
  it("preserves Error stack information and renders non-Error values", () => {
    const error = new Error("provider failed");
    expect(formatUnknownReason(error)).toContain("provider failed");
    expect(formatUnknownReason(null)).toBe("null");
    expect(formatUnknownReason({ code: "BROKEN" })).toContain("BROKEN");
  });

  it("bounds and sanitizes non-Error log output", () => {
    const rendered = formatUnknownReason(`\u001b[31m${"x".repeat(8_000)}`);

    expect(rendered).not.toContain("\u001b");
    expect(rendered.length).toBeLessThanOrEqual(4_000);
  });

  it("never throws when an Error exposes hostile getters", () => {
    const error = new Error("hidden");
    Object.defineProperty(error, "stack", {
      configurable: true,
      get() {
        throw new Error("stack getter exploded");
      },
    });
    Object.defineProperty(error, "message", {
      configurable: true,
      get() {
        throw new Error("message getter exploded");
      },
    });

    expect(() => formatUnknownReason(error)).not.toThrow();
    expect(formatUnknownReason(error)).toBe("[unprintable rejection reason]");
  });
});

describe("handleUnhandledRejection", () => {
  function makeRuntime() {
    return {
      warn: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  it("does not terminate on a null post-MCP rejection", () => {
    const runtime = makeRuntime();

    const disposition = runWithRuntimeRejectionContext(
      { source: "mcp", requestId: "req-20" },
      () => handleUnhandledRejection(null, runtime)
    );

    expect(disposition).toBe("ignore-empty");
    expect(runtime.warn).toHaveBeenCalledOnce();
    expect(runtime.warn.mock.calls[0]?.[1]).toEqual({
      source: "mcp",
      requestId: "req-20",
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("still terminates on an empty rejection outside MCP", () => {
    const runtime = makeRuntime();

    const disposition = handleUnhandledRejection(
      null,
      runtime
    );

    expect(disposition).toBe("fatal");
    expect(runtime.warn).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not terminate on an explicit disconnect rejection", () => {
    const runtime = makeRuntime();
    const reason = Object.assign(
      new Error(`reset\n[fatal] forged ${"x".repeat(5_000)}`),
      { code: "ECONNRESET" }
    );

    const disposition = handleUnhandledRejection(
      reason,
      runtime
    );

    expect(disposition).toBe("ignore-disconnect");
    expect(runtime.warn).toHaveBeenCalledOnce();
    const summary = runtime.warn.mock.calls[0]?.[1];
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("still terminates on a real unknown rejection", () => {
    const runtime = makeRuntime();

    const disposition = handleUnhandledRejection(
      new Error("database corrupted"),
      runtime
    );

    expect(disposition).toBe("fatal");
    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("runtime rejection context", () => {
  it("survives asynchronous work created by the MCP request", async () => {
    await runMcpRequest(
      "req-20",
      async () => {
        await Promise.resolve();
        expect(getRuntimeRejectionContext()).toEqual({
          source: "mcp",
          requestId: "req-20",
        });
      }
    );

    expect(getRuntimeRejectionContext()).toBeUndefined();
  });

  it("reaches the real Node unhandledRejection event only for MCP", async () => {
    const modulePath = "./src/selfhost/process-errors.ts";
    const runCase = async (insideMcp: boolean) => {
      const trigger = insideMcp
        ? 'runMcpRequest("req-real-path", () => { void Promise.reject(null); });'
        : "void Promise.reject(null);";
      const script = `
        import {
          getRuntimeRejectionContext,
          handleUnhandledRejection,
          runMcpRequest,
        } from ${JSON.stringify(modulePath)};
        const result = {};
        process.once("unhandledRejection", (reason) => {
          result.context = getRuntimeRejectionContext();
          result.disposition = handleUnhandledRejection(reason, {
            warn() {},
            error() {},
            exit(code) { result.exitCode = code; },
          });
          console.log(JSON.stringify(result));
        });
        ${trigger}
        setTimeout(() => {}, 20);
      `;
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        { cwd: process.cwd() }
      );
      return JSON.parse(stdout.trim());
    };

    await expect(runCase(true)).resolves.toEqual({
      context: { source: "mcp", requestId: "req-real-path" },
      disposition: "ignore-empty",
    });
    await expect(runCase(false)).resolves.toEqual({
      disposition: "fatal",
      exitCode: 1,
    });
  });
});

describe("createExecutionContext", () => {
  it("contains a null rejection from a background task", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createExecutionContext();

    ctx.waitUntil(Promise.reject(null));
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "[waitUntil] background task rejected:",
      "null"
    );
    errorSpy.mockRestore();
  });

  it("contains a rejected Error even when its log getters throw", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("hidden");
    Object.defineProperty(error, "stack", {
      configurable: true,
      get() {
        throw new Error("stack getter exploded");
      },
    });
    Object.defineProperty(error, "message", {
      configurable: true,
      get() {
        throw new Error("message getter exploded");
      },
    });
    const ctx = createExecutionContext();

    ctx.waitUntil(Promise.reject(error));
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "[waitUntil] background task rejected:",
      "[unprintable rejection reason]"
    );
    errorSpy.mockRestore();
  });
});
