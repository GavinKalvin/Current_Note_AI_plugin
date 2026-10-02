import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatGptHttp } from "../src/provider/chatgpt-http";
import { ProviderRequestError } from "../src/provider/errors";

const mockState = vi.hoisted(() => ({ response: undefined as undefined | {
  status?: number; headers?: Record<string, string>; chunks?: string[]; end?: boolean; aborted?: boolean;
}, requests: [] as Array<{ options: unknown; destroyed: boolean; endArg: unknown; emitter: EventEmitter }> }));

vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events");
  return { request: vi.fn((_target: unknown, options: unknown, callback: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { destroy: () => void; end: (body?: unknown) => void };
    const record = { options, destroyed: false, endArg: undefined as unknown, emitter: req };
    mockState.requests.push(record);
    req.destroy = () => { record.destroyed = true; };
    req.end = (body?: unknown) => {
      record.endArg = body;
      const response = mockState.response ?? {};
      setTimeout(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; setEncoding: (encoding: string) => void };
        res.statusCode = response.status ?? 200;
        res.headers = response.headers ?? {};
        res.setEncoding = () => undefined;
        callback(res);
        if (response.aborted) { res.emit("aborted"); return; }
        for (const chunk of response.chunks ?? []) res.emit("data", chunk);
        if (response.end !== false) res.emit("end");
      }, 0);
    };
    return req;
  }) };
});

const sse = "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\r\n\r\nevent: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n";
const call = (options: Parameters<typeof chatGptHttp>[1] = {}) => chatGptHttp("https://api.openai.com/v1/responses", options);

describe("ChatGPT HTTPS transport", () => {
  beforeEach(() => { mockState.response = undefined; mockState.requests.length = 0; });

  it("recognizes MIME-less fragmented SSE, buffering BOM and prefix until event/data/comment evidence", async () => {
    mockState.response = { chunks: ["\uFEFFev", "ent: response.output_text.delta\r\n", ": heartbeat\r\n", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\r\n\r\n"] };
    const onText = vi.fn();
    await expect(call({ onText })).resolves.toBe("");
    expect(onText.mock.calls.flat()).toEqual(["event: response.output_text.delta\r\n", ": heartbeat\r\n", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\r\n\r\n"]);
  });

  it("accepts an SSE body despite wrong MIME and normalizes event-stream MIME case", async () => {
    for (const headers of [{ "content-type": "application/json" }, { "content-type": "Text/Event-Stream; charset=UTF-8" }]) {
      mockState.response = { headers, chunks: [sse] };
      const onText = vi.fn();
      await expect(call({ onText })).resolves.toBe("");
      expect(onText).toHaveBeenCalledWith(sse);
    }
  });

  it("maps a structured HTTP 200 quota error without leaking raw details", async () => {
    const secret = "private raw service detail";
    mockState.response = { headers: { "content-type": "application/json" }, chunks: [JSON.stringify({ error: { code: "usage_limit_reached", message: secret } })] };
    const onText = vi.fn();
    await expect(call({ onText })).rejects.toMatchObject({ code: "quota", status: 200 });
    await expect(call({ onText })).rejects.toThrow();
    expect(onText).not.toHaveBeenCalled();
  });

  it("maps unauthorized JSON and never retries", async () => {
    mockState.response = { status: 401, headers: { "content-type": "application/json" }, chunks: [JSON.stringify({ error: { code: "unauthorized", message: "credential secret" } })] };
    await expect(call()).rejects.toMatchObject({ code: "authentication", status: 401 });
    expect(mockState.requests).toHaveLength(1);
  });

  it.each([{ chunks: ["<html>login</html>"] }, { chunks: ["{\"ok\":true}"] }])("rejects non-SSE successful responses", async (response) => {
    mockState.response = response;
    await expect(call({ onText: vi.fn() })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects redirects without following them", async () => {
    mockState.response = { status: 302, headers: { location: "https://attacker.example/collect" }, chunks: [] };
    await expect(call({ headers: { Authorization: "Bearer local-secret" } })).rejects.toBeInstanceOf(ProviderRequestError);
    expect(mockState.requests).toHaveLength(1);
  });

  it("does not issue a request for an already-aborted signal", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(call({ signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(mockState.requests).toHaveLength(0);
  });

  it("rejects an interrupted stream", async () => {
    mockState.response = { aborted: true, end: false };
    await expect(call({ onText: vi.fn() })).rejects.toMatchObject({ code: "interrupted" });
  });

  it("cleans up cancellation and timeout", async () => {
    mockState.response = { end: false };
    const controller = new AbortController();
    const pending = call({ signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(mockState.requests[0]?.destroyed).toBe(true);

    mockState.response = { end: false };
    await expect(call({ timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    expect(mockState.requests[1]?.destroyed).toBe(true);
  });

  it("enforces the 8 MiB response cap", async () => {
    mockState.response = { headers: { "content-type": "text/event-stream" }, chunks: ["x".repeat(8 * 1024 * 1024 + 1)] };
    await expect(call({ onText: vi.fn() })).rejects.toMatchObject({ code: "output-too-large" });
  });

  it("sanitizes arbitrary onText callback failures and preserves provider errors", async () => {
    mockState.response = { headers: { "content-type": "text/event-stream" }, chunks: [sse] };
    await expect(call({ onText: () => { throw new Error("private token"); } })).rejects.toMatchObject({ code: "invalid-response" });
    mockState.response = { headers: { "content-type": "text/event-stream" }, chunks: [sse] };
    const expected = new ProviderRequestError("chatgpt", "complete", "quota", "safe message", 429);
    await expect(call({ onText: () => { throw expected; } })).rejects.toBe(expected);
  });

  it("keeps JSON GET responses intact and restricts endpoint origins", async () => {
    mockState.response = { headers: { "content-type": "application/json" }, chunks: ["{\"models\":[]}"] };
    await expect(chatGptHttp("https://api.openai.com/v1/models")).resolves.toBe("{\"models\":[]}");
    for (const url of ["http://api.openai.com/v1/models", "https://attacker.example/", "https://api.openai.com.evil.test/"]) {
      await expect(chatGptHttp(url)).rejects.toMatchObject({ code: "invalid-endpoint" });
    }
    expect(mockState.requests).toHaveLength(1);
  });
});
