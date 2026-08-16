import type { ProviderId } from "../types";

export type ProviderOperation = "list-models" | "complete";

export class ProviderRequestError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    public readonly operation: ProviderOperation,
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
