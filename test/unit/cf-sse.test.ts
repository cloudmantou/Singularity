import { describe, expect, it, vi } from "vitest";
import { collectCfSseText } from "../../src/providers/cf-sse";

describe("collectCfSseText", () => {
  it("collects split provider events while forwarding each decoded delta", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"res'));
        controller.enqueue(encoder.encode('ponse":"你"}\n\ndata: {"response":"好"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const onDelta = vi.fn();

    await expect(collectCfSseText(stream, { onDelta })).resolves.toBe("你好");
    expect(onDelta.mock.calls.map((call) => call[0])).toEqual(["你", "好"]);
  });

  it("rejects malformed provider JSON instead of silently finalizing a draft", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {bad-json}\n\n'));
        controller.close();
      },
    });

    await expect(collectCfSseText(stream)).rejects.toThrow();
  });

  it("rejects provider errors delivered inside an HTTP 200 stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"error":{"message":"provider overloaded"}}\n\n'
        ));
        controller.close();
      },
    });

    await expect(collectCfSseText(stream)).rejects.toThrow("provider overloaded");
  });

  it("rejects provider streams that end before DONE", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"response":"partial"}\n\n'
        ));
        controller.close();
      },
    });

    await expect(collectCfSseText(stream)).rejects.toThrow("before DONE");
  });

  it("rejects provider events after DONE", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: [DONE]\n\ndata: {"response":"late"}\n\n'
        ));
        controller.close();
      },
    });

    await expect(collectCfSseText(stream)).rejects.toThrow("after DONE");
  });
});
