import { describe, expect, it, vi } from "vitest";
import { ChatGptAdapter, ChatGptResponseStream, buildChatGptRequest, parseChatGptModels } from "../src/provider/chatgpt";

const req = (model = "gpt-test", maxTokens = 800) => ({ messages: [
  { role: "system" as const, content: "Be precise" }, { role: "user" as const, content: "Hello" }, { role: "assistant" as const, content: "Prior" },
], options: { model, maxTokens, temperature: 0.3, responseFormat: "text" as const } });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;

describe("ChatGPT plan provider", () => {
  it("supplements missing Sol after an authenticated catalog refresh without inference", async () => {
    const auth = { accessToken: vi.fn(async () => "fixture-token") };
    const http = vi.fn(async () => JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list" }] }));
    const adapter = new ChatGptAdapter("fixture-account", auth, http);
    expect(await adapter.listModels("ignored-api-key")).toMatchObject([
      { id: "gpt-6.1-sol", catalogSource: "manual" }, { id: "gpt-6-astra" },
    ]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.anything());
  });
  it("uses the exact GPT-6.1 Sol ID and requested effort without model fallback", () => {
    expect(buildChatGptRequest({ ...req("gpt-6.1-sol"), options: { ...req("gpt-6.1-sol").options, reasoningEffort: "max", serviceTier: "fast" } })).toMatchObject({
      model: "gpt-6.1-sol", reasoning: { effort: "max" }, service_tier: "fast",
    });
  });
  it("accepts only listed plan models, retaining order and deduplicating slugs", () => {
    expect(parseChatGptModels(JSON.stringify({ models: [
      { slug: "one", display_name: "One", visibility: "list" }, { slug: "hidden", visibility: "hide" },
      { slug: "two", display_name: "Two", visibility: "list" }, { slug: "one", display_name: "Duplicate", visibility: "list" },
    ] }))).toMatchObject([{ id: "one", displayName: "One" }, { id: "two", displayName: "Two" }]);
    expect(() => parseChatGptModels('{"data":[]}')).toThrow(/catalog/i);
    expect(() => parseChatGptModels("not json")).toThrow();
  });

  it("exposes the model's declared reasoning-effort choices only", () => {
    expect(parseChatGptModels(JSON.stringify({ models: [{ slug: "reasoner", visibility: "list", supported_reasoning_levels: [
      { effort: "low" }, { effort: "high" }, { effort: "not-supported" },
    ] }] }))).toMatchObject([{ id: "reasoner", supportedReasoningEfforts: ["low", "high"] }]);
  });

  it("builds the constrained Responses payload without unsupported parameters", () => {
    const body = buildChatGptRequest(req() as never);
    expect(body).toMatchObject({ model: "gpt-test", store: false, stream: true, tools: [], input: [
      { role: "user", content: "Hello" }, { role: "assistant", content: "Prior" },
    ] });
    expect(body.instructions).toContain("Be precise");
    for (const key of ["max_output_tokens", "temperature", "previous_response_id", "truncation"]) expect(body).not.toHaveProperty(key);
  });

  it("sends explicit reasoning and speed selections, omitting automatic choices", () => {
    const manual = buildChatGptRequest({ ...req(), options: { ...req().options, reasoningEffort: "high", serviceTier: "fast" } } as never);
    expect(manual).toMatchObject({ reasoning: { effort: "high" }, service_tier: "fast" });
    const defaultSpeed = buildChatGptRequest({ ...req(), options: { ...req().options, reasoningEffort: undefined, serviceTier: "default" } } as never);
    expect(defaultSpeed).not.toHaveProperty("reasoning"); expect(defaultSpeed).toHaveProperty("service_tier", "default");
    const automatic = buildChatGptRequest(req() as never);
    expect(automatic).not.toHaveProperty("reasoning"); expect(automatic).toHaveProperty("service_tier", "default");
  });

  it("parses fragmented CRLF SSE and completed usage while hiding reasoning", () => {
    const parser = new ChatGptResponseStream();
    const events = frame({ type: "response.output_item.added", item: { type: "reasoning" } }) +
      frame({ type: "response.output_text.delta", delta: "Visible" }) +
      frame({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9, output_tokens_details: { reasoning_tokens: 2 } }, output: [{ type: "reasoning", summary: [{ text: "secret" }] }] } });
    parser.feed(events.slice(0, 13)); parser.feed(events.slice(13));
    expect(parser.finish()).toEqual({ content: "Visible", finishReason: "stop", usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9, reasoningTokens: 2 } });
  });

  it.each(["default", "priority", "fast", "ultrafast", "standard"])("reports only normalized actual service tier %s", (tier) => {
    const parser = new ChatGptResponseStream();
    parser.feed(frame({ type: "response.output_text.delta", delta: "ok" }));
    parser.feed(frame({ type: "response.completed", response: { status: "completed", service_tier: tier } }));
    expect(parser.finish()).toMatchObject({ content: "ok", actualServiceTier: tier === "standard" ? "default" : tier });
  });

  it.each([
    ["incomplete", { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, "length"],
    ["missing terminal", undefined, "unknown"], ["unknown status", { type: "response.completed", response: { status: "queued" } }, "unknown"],
  ])("does not treat %s as a normal completion", (_label, terminal, finishReason) => {
    const parser = new ChatGptResponseStream(); parser.feed(frame({ type: "response.output_text.delta", delta: "x" }));
    if (terminal) parser.feed(frame(terminal));
    expect(parser.finish()).toMatchObject({ content: "x", finishReason });
  });

  it("rejects malformed events, tool calls, and quota failures after a delta", () => {
    for (const data of ["data: {oops}\n\n", frame({ type: "response.output_item.added", item: { type: "function_call" } })]) {
      const parser = new ChatGptResponseStream(); expect(() => { parser.feed(data); }).toThrow();
    }
    const parser = new ChatGptResponseStream(); parser.feed(frame({ type: "response.output_text.delta", delta: "partial" }));
    expect(() => parser.feed(frame({ type: "response.failed", response: { error: { code: "usage_limit_reached", message: "private detail" } } }))).toThrow(/usage limit/i);
  });

  it("uses only the fixed official endpoint, propagates cancellation, ignores API keys, and budget-checks before auth", async () => {
    const auth = { accessToken: vi.fn(async (_id: string, signal?: AbortSignal) => { if (signal?.aborted) throw Error("cancelled"); return "token"; }) };
    const http = vi.fn(async (_url: string, options?: { onText?: (text: string) => void }) => { options?.onText?.(frame({ type: "response.output_text.delta", delta: "ok" })); options?.onText?.(frame({ type: "response.completed", response: { status: "completed" } })); return ""; });
    const adapter = new ChatGptAdapter("", auth, http as never);
    await expect(adapter.complete("ignored-api-key", req() as never)).resolves.toMatchObject({ content: "ok" });
    expect(http.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(http.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer token" } });
    await expect(adapter.complete("", req("gpt-test", 20_000) as never)).rejects.toMatchObject({ code: "invalid-budget" });
    expect(auth.accessToken).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    await expect(adapter.complete("", req() as never, controller.signal)).rejects.toThrow(/cancelled/);
  });
});
