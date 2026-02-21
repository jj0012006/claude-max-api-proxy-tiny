/**
 * Centralized configuration for the proxy server.
 * All values are read from environment variables with sensible defaults.
 */

export interface ProxyConfig {
  /** OpenClaw gateway base URL for health checks */
  openclawBaseUrl: string;
}

export function loadConfig(): ProxyConfig {
  return {
    openclawBaseUrl: process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:18789",
  };
}

export const config = loadConfig();
