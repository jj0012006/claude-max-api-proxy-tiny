/**
 * Centralized configuration for the proxy server.
 * All values are read from environment variables with sensible defaults.
 */

export interface ProxyConfig {
  /** LiteLLM base URL for Gemini access */
  litellmBaseUrl: string;
  /** Model used for routing decisions (should be fast & cheap) */
  routerModel: string;
  /** Enable intelligent routing; false = all requests go to Claude */
  routerEnabled: boolean;
  /** Default Gemini model when router picks gemini */
  geminiDefaultModel: string;
}

export function loadConfig(): ProxyConfig {
  return {
    litellmBaseUrl: process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000",
    routerModel: process.env.ROUTER_MODEL || "gemini-flash",
    routerEnabled: process.env.ROUTER_ENABLED !== "false",
    geminiDefaultModel: process.env.GEMINI_DEFAULT_MODEL || "gemini-pro",
  };
}

export const config = loadConfig();
