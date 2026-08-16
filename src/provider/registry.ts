import type { ProviderAdapter, ProviderId } from "../types";
import { DeepSeekAdapter } from "./deepseek";
import { KimiAdapter } from "./kimi";

export interface ProviderRegistration {
  providerId: ProviderId;
  displayName: string;
  baseUrl: string;
  createAdapter(): ProviderAdapter;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderRegistration> = {
  deepseek: {
    providerId: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    createAdapter: () => new DeepSeekAdapter(),
  },
  kimi: {
    providerId: "kimi",
    displayName: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    createAdapter: () => new KimiAdapter(),
  },
};

export function getProviderRegistration(providerId: ProviderId): ProviderRegistration {
  return PROVIDER_REGISTRY[providerId];
}
