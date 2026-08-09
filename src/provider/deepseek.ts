import { requestUrl } from "obsidian";
import type {
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  ProviderAdapter,
  ProviderModel,
} from "../types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export class ProviderRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseEnvelope(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text.trim());
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new ProviderRequestError(
      "invalid-response",
      "DeepSeek returned a response that could not be parsed.",
    );
  }
}

function providerErrorMessage(envelope: Record<string, unknown>, status: number): string {
  const error = asRecord(envelope.error);
  const message = error?.message;
  return typeof message === "string" && message.length > 0
    ? message.slice(0, 500)
    : `DeepSeek request failed with HTTP ${status}.`;
}

function usageFrom(value: unknown): CompletionUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    promptTokens: typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined,
    completionTokens: typeof record.completion_tokens === "number" ? record.completion_tokens : undefined,
    totalTokens: typeof record.total_tokens === "number" ? record.total_tokens : undefined,
  };
}

export class DeepSeekAdapter implements ProviderAdapter {
  constructor(private readonly baseUrl = DEFAULT_BASE_URL) {}

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await requestUrl({
      url: `${this.baseUrl}/models`,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      throw: false,
    });
    const envelope = parseEnvelope(response.text);
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderRequestError(
        `http-${response.status}`,
        providerErrorMessage(envelope, response.status),
        response.status,
        response.headers["retry-after"],
      );
    }

    if (!Array.isArray(envelope.data)) {
      throw new ProviderRequestError("invalid-response", "DeepSeek did not return a model list.");
    }

    return envelope.data.flatMap((item) => {
      const model = asRecord(item);
      if (!model || typeof model.id !== "string") return [];
      return [{
        id: model.id,
        ownedBy: typeof model.owned_by === "string" ? model.owned_by : undefined,
      }];
    });
  }

  async complete(apiKey: string, request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.options.model,
      messages: request.messages,
      max_tokens: request.options.maxTokens,
      temperature: request.options.temperature,
      stream: false,
    };
    if (request.options.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const response = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      throw: false,
    });
    const envelope = parseEnvelope(response.text);
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderRequestError(
        `http-${response.status}`,
        providerErrorMessage(envelope, response.status),
        response.status,
        response.headers["retry-after"],
      );
    }

    const firstChoice = Array.isArray(envelope.choices)
      ? asRecord(envelope.choices[0])
      : null;
    const message = asRecord(firstChoice?.message);
    const content = message?.content;
    const finishReason = firstChoice?.finish_reason;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ProviderRequestError("empty-response", "DeepSeek returned an empty response.");
    }

    return {
      content,
      finishReason: typeof finishReason === "string" ? finishReason : "unknown",
      usage: usageFrom(envelope.usage),
    };
  }
}
