import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { KimiAdapter } from "../src/provider/kimi";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const mockedRequestUrl = vi.mocked(requestUrl);
function response(value: unknown) { return value as never; }
function completionRequest(model = "kimi-k2.6", responseFormat: "text" | "json" = "text") {
  return {
    messages: [{ role: "user" as const, content: "Hello" }],
    options: { model, maxTokens: 100, temperature: 0.2, responseFormat },
  };
}

describe("KimiAdapter", () => {
  beforeEach(() => mockedRequestUrl.mockReset());

  it("parses model capabilities and ignores malformed entries", async () => {
    mockedRequestUrl.mockResolvedValue(response({ status: 200, headers: {}, text: JSON.stringify({ data: [
      { id: "kimi-k2.6", owned_by: "moonshot", context_length: 262144, supports_reasoning: true },
      { id: "bad-context", context_length: 0, supports_reasoning: "yes" },
      { context_length: 10 }, null,
    ] }) }));
    await expect(new KimiAdapter("https://example.test").listModels("key")).resolves.toEqual([
      { id: "kimi-k2.6", ownedBy: "moonshot", contextWindowTokens: 262144, supportsReasoning: true },
      { id: "bad-context", ownedBy: undefined, contextWindowTokens: undefined, supportsReasoning: undefined },
    ]);
    expect(mockedRequestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.test/models", method: "GET" }));
  });

  it.each([
    [401, "Unauthorized"],
    [429, "Too many requests"],
  ])("keeps HTTP-specific error for non-JSON %s response", async (status, text) => {
    mockedRequestUrl.mockResolvedValue(response({ status, text, headers: { "rEtRy-AfTeR": "7" } }));
    await expect(new KimiAdapter().listModels("key")).rejects.toMatchObject({
      providerId: "kimi", code: `http-${status}`, status, retryAfter: "7",
      message: `Kimi request failed with HTTP ${status}.`,
    });
  });

  it("sends the Kimi wire payload without temperature or reasoning_effort", async () => {
    mockedRequestUrl.mockResolvedValue(response({ status: 200, headers: {}, text: JSON.stringify({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 20 },
    }) }));
    const result = await new KimiAdapter("https://example.test").complete("key", completionRequest("kimi-k2.6", "json"));
    const call = mockedRequestUrl.mock.calls[0]?.[0] as { url: string; body: string };
    expect(call.url).toBe("https://example.test/chat/completions");
    const body = JSON.parse(call.body);
    expect(body).toEqual(expect.objectContaining({ model: "kimi-k2.6", max_tokens: 100, stream: false, thinking: { type: "disabled" }, response_format: { type: "json_object" } }));
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(result).toEqual({ content: "{\"ok\":true}", finishReason: "stop", usage: {
      promptTokens: 12, completionTokens: 8, reasoningTokens: 3, visibleOutputTokens: 5, totalTokens: 20,
    } });
  });

  it("rejects an unsupported model before making a network call", async () => {
    await expect(new KimiAdapter().complete("key", completionRequest("kimi-k2.5"))).rejects.toMatchObject({
      providerId: "kimi", operation: "complete", code: "unsupported-model",
    });
    expect(mockedRequestUrl).not.toHaveBeenCalled();
  });

  it("rejects malformed and empty successful responses", async () => {
    mockedRequestUrl.mockResolvedValue(response({ status: 200, headers: {}, text: "not json" }));
    await expect(new KimiAdapter().complete("key", completionRequest())).rejects.toMatchObject({ code: "invalid-response" });
    mockedRequestUrl.mockResolvedValue(response({ status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }) }));
    await expect(new KimiAdapter().complete("key", completionRequest())).rejects.toMatchObject({ code: "empty-response" });
  });

  it("times out locally", async () => {
    mockedRequestUrl.mockImplementation(() => response(new Promise((resolve) => {
      setTimeout(() => resolve({ status: 200, headers: {}, text: "{}" }), 100);
    })));
    const pending = new KimiAdapter("https://example.test", 10).listModels("key");
    await expect(pending).rejects.toMatchObject({ providerId: "kimi", code: "timeout" });
  });
});
