import { request } from "node:https";
import { ProviderRequestError } from "./errors";

export function chatGptFailure(code: string, message: string, status?: number): ProviderRequestError {
  return new ProviderRequestError("chatgpt", "complete", code, message, status);
}

export function chatGptServiceError(code: string, status?: number, param?: string): ProviderRequestError {
  if (code === "subscription_sharing_user_not_eligible") return chatGptFailure("ineligible", "ChatGPT plan sharing is unavailable for this account, workspace, or policy. Repeating sign-in will not bypass that restriction.", status);
  if (code === "subscription_sharing_unsupported_capability" || code === "unsupported_value" || code === "invalid_value") {
    const field = ["model", "reasoning.effort", "service_tier"].includes(param ?? "") ? ` (${param})` : "";
    return chatGptFailure("unsupported-option", `ChatGPT rejected a model, reasoning, speed, or request capability${field}. Change the selected option; no silent downgrade or automatic retry was made.`, status);
  }
  if (code === "subscription_sharing_route_not_supported") return chatGptFailure("unsupported-route", "ChatGPT plan sharing does not permit this route for the selected account. No other billing path was used.", status);
  if (code === "subscription_sharing_usage_unavailable" || status === 503) return chatGptFailure("temporarily-unavailable", "ChatGPT plan usage is temporarily unavailable. Credentials were preserved; retry later manually.", status);
  if (/^(invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused)$/u.test(code)) return chatGptFailure("refresh-expired", "The ChatGPT renewable session expired or was revoked. Continue with ChatGPT again.", status);
  if (status === 429 || /usage_limit|quota|rate_limit/iu.test(code)) {
    return chatGptFailure("quota", "ChatGPT plan or app usage limit reached. Manage usage at https://chatgpt.com/settings/usage. No API-key fallback or automatic inference retry was made.", status);
  }
  if (status === 401 || status === 403 || /invalid_grant|unauthorized|permission|consent|sharing_disabled/iu.test(code)) {
    return chatGptFailure("authentication", "Continue with ChatGPT again and authorize plan usage. This source never uses an API key or another app's credentials.", status);
  }
  return chatGptFailure("service-error", "ChatGPT could not complete this request. Check account access and connection; no automatic inference retry was made.", status);
}

export interface ChatGptHttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onText?: (text: string) => void;
}
export type ChatGptHttp = (url: string, options?: ChatGptHttpOptions) => Promise<string>;

/** Native desktop transport: fixed official HTTPS origins, no redirects or raw errors. */
export const chatGptHttp: ChatGptHttp = (url, options = {}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  if (target.protocol !== "https:" || !["auth.openai.com", "api.openai.com"].includes(target.hostname)
    || target.port || target.username || target.password || target.hash) {
    reject(chatGptFailure("invalid-endpoint", "Only official OpenAI HTTPS endpoints are supported.")); return;
  }
  if (options.signal?.aborted) { reject(chatGptFailure("cancelled", "ChatGPT request cancelled.")); return; }
  let settled = false;
  let received = 0;
  let body = "";
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (error) { req.destroy(); reject(error); } else resolve(body);
  };
  const req = request(target, { method: options.method ?? "GET", headers: options.headers }, (res) => {
    const status = res.statusCode ?? 0;
    const success = status >= 200 && status < 300;
    const expectsStream = success && !!options.onText;
    const contentType = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    let verifiedStream = contentType === "text/event-stream";
    const invalidFormat = () => chatGptFailure("invalid-response", "ChatGPT returned a non-SSE response. No answer or edit was accepted; check the connection and account access.", status);
    res.setEncoding("utf8");
    res.on("data", (text: string) => {
      received += Buffer.byteLength(text, "utf8");
      if (received > 8 * 1024 * 1024) { finish(chatGptFailure("output-too-large", "ChatGPT output exceeded the local safety limit.")); return; }
      if (settled) return;
      try {
        if (expectsStream && verifiedStream) options.onText!(text);
        else {
          body += text;
          if (expectsStream) {
            // Some delivery paths omit or mislabel Content-Type while still
            // returning valid SSE. Inspect only the framing, never accept a
            // JSON/HTML body as a successful stream or invent a terminal event.
            const prefix = body.replace(/^\uFEFF/u, "").trimStart();
            if (/^(?:event:|data:|:)/u.test(prefix)) {
              verifiedStream = true;
              options.onText!(body.replace(/^\uFEFF/u, ""));
              body = "";
            } else if (prefix.startsWith("<")) throw invalidFormat();
            else if (prefix.length > 8192 && !prefix.startsWith("{") && !prefix.startsWith("[")) throw invalidFormat();
          }
        }
      } catch (error) {
        finish(error instanceof ProviderRequestError ? error : chatGptFailure("invalid-response", "ChatGPT returned an invalid event stream."));
      }
    });
    res.on("aborted", () => finish(chatGptFailure("interrupted", "ChatGPT stream was interrupted. No edit was applied.")));
    res.on("error", () => finish(chatGptFailure("network", "ChatGPT connection failed. No automatic retry was made.")));
    res.on("end", () => {
      if (!success || (expectsStream && !verifiedStream)) {
        let code = "unknown";
        let param: string | undefined;
        let structuredError = false;
        try {
          const parsed = JSON.parse(body);
          structuredError = !!parsed?.error;
          code = String(parsed?.error?.code ?? parsed?.error ?? "unknown");
          if (typeof parsed?.error?.param === "string") param = parsed.error.param;
        } catch { /* Never surface HTML or raw response bodies. */ }
        finish(success && !structuredError ? invalidFormat() : chatGptServiceError(code, status, param));
      } else finish();
    });
  });
  const abort = () => finish(chatGptFailure("cancelled", "ChatGPT request stopped locally; already submitted requests may consume plan usage."));
  const timer = setTimeout(() => finish(chatGptFailure("timeout", "ChatGPT request timed out; already submitted requests may consume plan usage.")), options.timeoutMs ?? 30_000);
  req.on("error", () => finish(chatGptFailure("network", "Could not connect to OpenAI. Check your network; no automatic retry was made.")));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  req.end(options.body);
});
