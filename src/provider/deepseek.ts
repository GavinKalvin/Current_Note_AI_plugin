import { requestUrl } from "obsidian";
import type {
  CompletionRequest,
  CompletionResponse,
  ProviderAdapter,
  ProviderModel,
} from "../types";
import { parseCompletionUsage } from "../core/completion";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 120_000;

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

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

export class DeepSeekAdapter implements ProviderAdapter {
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("DeepSeek timeoutMs must be a finite positive number.");
    }
    this.timeoutMs = timeoutMs;
  }

  private async request(options: Parameters<typeof requestUrl>[0]): Promise<Awaited<ReturnType<typeof requestUrl>>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ProviderRequestError(
          "timeout",
          "DeepSeek request timed out locally and may still be processed remotely.",
        ));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([requestUrl(options), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await this.request({
      url: `${this.baseUrl}/models`,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      let envelope: Record<string, unknown> = {};
      try {
        envelope = parseEnvelope(response.text);
      } catch {
        // Preserve the HTTP-specific error when an error response is not JSON.
      }
      throw new ProviderRequestError(
        `http-${response.status}`,
        providerErrorMessage(envelope, response.status),
        response.status,
        headerValue(response.headers, "retry-after"),
      );
    }
    const envelope = parseEnvelope(response.text);

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
      thinking: { type: request.options.thinking },
      stream: false,
    };
    if (request.options.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const response = await this.request({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      let envelope: Record<string, unknown> = {};
      try {
        envelope = parseEnvelope(response.text);
      } catch {
        // Preserve the HTTP-specific error when an error response is not JSON.
      }
      throw new ProviderRequestError(
        `http-${response.status}`,
        providerErrorMessage(envelope, response.status),
        response.status,
        headerValue(response.headers, "retry-after"),
      );
    }
    const envelope = parseEnvelope(response.text);

    const firstChoice = Array.isArray(envelope.choices)
      ? asRecord(envelope.choices[0])
      : null;
    const message = asRecord(firstChoice?.message);
    const content = message?.content;
    const finishReason = firstChoice?.finish_reason;
    if (typeof content !== "string") {
      throw new ProviderRequestError("empty-response", "DeepSeek returned an empty response.");
    }
    if (content.trim().length === 0 && finishReason === "stop") {
      throw new ProviderRequestError("empty-response", "DeepSeek returned an empty completed response.");
    }

    return {
      content,
      finishReason: typeof finishReason === "string" ? finishReason : "unknown",
      usage: parseCompletionUsage(envelope.usage),
    };
  }
}
