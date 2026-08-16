import type { ProviderId } from "../types";

export type ProviderOperation = "list-models" | "complete";

/** A request was rejected by local profile routing before any provider call. */
export class ProfileRoutingError extends Error {
  constructor(
    public readonly code:
      | "missing-profile"
      | "disabled-profile"
      | "revision-mismatch"
      | "unknown-model"
      | "missing-secret"
      | "invalid-selection",
    message: string,
    public readonly profileId?: string,
  ) {
    super(message);
    this.name = "ProfileRoutingError";
  }
}

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
