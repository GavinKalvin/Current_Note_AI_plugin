import type { ProviderAdapter, ProviderId } from "../types";
import { DeepSeekAdapter } from "./deepseek";
import { KimiAdapter } from "./kimi";
import { KimiCodeAdapter } from "./kimi-code";
import { ChatGptAdapter } from "./chatgpt";

export interface ProviderRegistration {
  providerId: ProviderId;
  displayName: string;
  createAdapter(baseUrl: string, cliPath?: string, chatgptAccountId?: string): ProviderAdapter;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderRegistration> = {
  chatgpt: {
    providerId: "chatgpt",
    displayName: "ChatGPT · Plan quota",
    createAdapter: (_baseUrl, _cliPath, accountId) => new ChatGptAdapter(accountId),
  },
  "kimi-code": {
    providerId: "kimi-code",
    displayName: "Kimi Code · Local quota",
    createAdapter: (_baseUrl, cliPath) => new KimiCodeAdapter(cliPath),
  },
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
