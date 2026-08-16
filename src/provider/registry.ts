import type { ProviderAdapter, ProviderId } from "../types";
import { DeepSeekAdapter } from "./deepseek";
import { KimiAdapter } from "./kimi";

export interface ProviderRegistration {
  providerId: ProviderId;
  displayName: string;
  createAdapter(baseUrl: string): ProviderAdapter;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderRegistration> = {
  deepseek: {
    providerId: "deepseek",
    displayName: "DeepSeek",
    createAdapter: (baseUrl) => new DeepSeekAdapter(baseUrl),
  },
  kimi: {
    providerId: "kimi",
    displayName: "Kimi",
    createAdapter: (baseUrl) => new KimiAdapter(baseUrl),
  },
};

export function getProviderRegistration(providerId: ProviderId): ProviderRegistration {
  return PROVIDER_REGISTRY[providerId];
}
