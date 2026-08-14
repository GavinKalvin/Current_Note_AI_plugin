import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { DeepSeekAdapter, ProviderRequestError } from "../src/provider/deepseek";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const mockedRequestUrl = vi.mocked(requestUrl);

function response(value: unknown) {
  return value as never;
}

function completionRequest() {
  return {
    messages: [{ role: "user" as const, content: "Hello" }],
    options: {
      model: "deepseek-chat",
      maxTokens: 100,
      temperature: 0.2,
      thinking: "disabled" as const,
      responseFormat: "text" as const,
    },
  };
}

describe("DeepSeekAdapter", () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset();
  });

  it("keeps an HTTP-specific error for a non-JSON 429 response", async () => {
    mockedRequestUrl.mockResolvedValue(response({
      status: 429,
      text: "Too many requests",
      headers: { "Retry-After": "7" },
    }));

    const error = await new DeepSeekAdapter("https://example.test").listModels("key")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({
      code: "http-429",
      status: 429,
      retryAfter: "7",
      message: "DeepSeek request failed with HTTP 429.",
    });
  });

  it("uses the provider message and preserves a JSON 401 error", async () => {
    mockedRequestUrl.mockResolvedValue(response({
      status: 401,
      text: JSON.stringify({ error: { message: "Invalid API key" } }),
      headers: {},
    }));

    await expect(new DeepSeekAdapter().listModels("bad-key")).rejects.toMatchObject({
      code: "http-401",
      status: 401,
      message: "Invalid API key",
    });
  });

  it("rejects malformed successful responses as invalid-response", async () => {
    mockedRequestUrl.mockResolvedValue(response({ status: 200, text: "not json", headers: {} }));

    await expect(new DeepSeekAdapter().complete("key", completionRequest()))
      .rejects.toMatchObject({ code: "invalid-response" });
  });

  it("returns a normal completion", async () => {
    mockedRequestUrl.mockResolvedValue(response({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
      }),
      headers: {},
    }));

    await expect(new DeepSeekAdapter().complete("key", completionRequest())).resolves.toEqual({
      content: "Hi",
      finishReason: "stop",
      usage: undefined,
    });
  });

  it("fails locally when requestUrl exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    mockedRequestUrl.mockImplementation(() => response(new Promise(() => undefined)));

    const request = new DeepSeekAdapter("https://example.test", 10).listModels("key");
    const expectation = expect(request)
      .rejects.toMatchObject({
        code: "timeout",
        message: "DeepSeek request timed out locally and may still be processed remotely.",
      });
    vi.advanceTimersByTime(10);
    await expectation;
    vi.useRealTimers();
  });
});
