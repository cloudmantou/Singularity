function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function isMcpToolsListRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const payload = await request.clone().json();
    return isRecord(payload) && payload.method === "tools/list";
  } catch {
    return false;
  }
}

export function removeToolExecutionMetadata(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
    return payload;
  }
  const tools = payload.result.tools.map((tool) => {
    if (!isRecord(tool) || !("execution" in tool)) return tool;
    const { execution: _execution, ...rest } = tool;
    return rest;
  });
  return {
    ...payload,
    result: {
      ...payload.result,
      tools,
    },
  };
}

export async function sanitizeToolsListResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const isSse = contentType.includes("text/event-stream");
  if (!isJson && !isSse) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (isSse) {
    const body = await response.clone().text();
    const sanitized = body.split("\n").map((line) => {
      if (!line.startsWith("data: ")) return line;
      try {
        const payload = JSON.parse(line.slice(6));
        return `data: ${JSON.stringify(removeToolExecutionMetadata(payload))}`;
      } catch {
        return line;
      }
    }).join("\n");
    return new Response(sanitized, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  try {
    const payload = await response.clone().json();
    return new Response(JSON.stringify(removeToolExecutionMetadata(payload)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}
