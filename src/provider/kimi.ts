import { requestUrl } from "obsidian";
import type {
  CompletionRequest,
  CompletionResponse,
  ProviderAdapter,
  ProviderModel,
} from "../types";
import { parseCompletionUsage } from "../core/completion";
import { ProviderRequestError } from "./errors";

const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_TIMEOUT_MS = 120_000;
const KIMI_MODEL = "kimi-k2.6";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseEnvelope(text: string, operation: "list-models" | "complete"): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text.trim());
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new ProviderRequestError(
      "kimi",
      operation,
      "invalid-response",
      "Kimi returned a response that could not be parsed.",
    );
  }
}

function providerErrorMessage(envelope: Record<string, unknown>, status: number): string {
  const error = asRecord(envelope.error);
  const message = error?.message;
  return typeof message === "string" && message.length > 0
    ? message.slice(0, 500)
    : `Kimi request failed with HTTP ${status}.`;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

export class KimiAdapter implements ProviderAdapter {
  readonly id = "kimi" as const;
  readonly displayName = "Kimi";
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Kimi timeoutMs must be a finite positive number.");
    }
    this.timeoutMs = timeoutMs;
  }

  private async request(options: Parameters<typeof requestUrl>[0]): Promise<Awaited<ReturnType<typeof requestUrl>>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ProviderRequestError(
          "kimi",
          (typeof options === "string" || options.method === "GET") ? "list-models" : "complete",
          "timeout",
          "Kimi request timed out locally and may still be processed remotely.",
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
      try { envelope = parseEnvelope(response.text, "list-models"); } catch { /* preserve HTTP error */ }
      throw new ProviderRequestError(
        "kimi", "list-models", `http-${response.status}`,
        providerErrorMessage(envelope, response.status), response.status,
        headerValue(response.headers, "retry-after"),
      );
    }
    const envelope = parseEnvelope(response.text, "list-models");
    if (!Array.isArray(envelope.data)) {
      throw new ProviderRequestError("kimi", "list-models", "invalid-response", "Kimi did not return a model list.");
    }
    return envelope.data.flatMap((item) => {
      const model = asRecord(item);
      if (!model || typeof model.id !== "string") return [];
      const contextLength = model.context_length;
      return [{
        id: model.id,
        ownedBy: typeof model.owned_by === "string" ? model.owned_by : undefined,
        contextWindowTokens: typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0
          ? contextLength : undefined,
        supportsReasoning: typeof model.supports_reasoning === "boolean" ? model.supports_reasoning : undefined,
      }];
    });
  }

  async complete(apiKey: string, request: CompletionRequest): Promise<CompletionResponse> {
    if (request.options.model !== KIMI_MODEL) {
      throw new ProviderRequestError("kimi", "complete", "unsupported-model", `Kimi does not support model ${request.options.model}.`);
    }
    const body: Record<string, unknown> = {
      model: request.options.model,
      messages: request.messages,
      max_tokens: request.options.maxTokens,
      stream: false,
      thinking: { type: "disabled" },
    };
    if (request.options.responseFormat === "json") body.response_format = { type: "json_object" };

    const response = await this.request({
      url: `${this.baseUrl}/chat/completions`, method: "POST", contentType: "application/json",
      headers: { Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      let envelope: Record<string, unknown> = {};
      try { envelope = parseEnvelope(response.text, "complete"); } catch { /* preserve HTTP error */ }
      throw new ProviderRequestError(
        "kimi", "complete", `http-${response.status}`,
        providerErrorMessage(envelope, response.status), response.status,
        headerValue(response.headers, "retry-after"),
      );
    }
    const envelope = parseEnvelope(response.text, "complete");
    const firstChoice = Array.isArray(envelope.choices) ? asRecord(envelope.choices[0]) : null;
    const message = asRecord(firstChoice?.message);
    const content = message?.content;
    const finishReason = firstChoice?.finish_reason;
    if (typeof content !== "string" || (content.trim().length === 0 && finishReason === "stop")) {
      throw new ProviderRequestError("kimi", "complete", "empty-response", "Kimi returned an empty response.");
    }
    return {
      content,
      finishReason: typeof finishReason === "string" ? finishReason : "unknown",
      usage: parseCompletionUsage(envelope.usage),
    };
  }
}

export { ProviderRequestError } from "./errors";
