/**
 * In-memory statistics collector
 *
 * Tracks request counts, routing decisions, and errors.
 * Stats are lost on process restart (by design — lightweight).
 */

export interface Stats {
  uptimeSeconds: number;
  uptimeHuman: string;
  totalRequests: number;
  claudeRequests: number;
  geminiRequests: number;
  routerErrors: number;
  routerFallbacks: number;
}

class StatsCollector {
  private startTime = Date.now();
  private totalRequests = 0;
  private claudeRequests = 0;
  private geminiRequests = 0;
  private routerErrors = 0;
  private routerFallbacks = 0;

  recordRequest(provider: "claude" | "gemini"): void {
    this.totalRequests++;
    if (provider === "claude") {
      this.claudeRequests++;
    } else {
      this.geminiRequests++;
    }
  }

  recordRouterError(): void {
    this.routerErrors++;
  }

  recordRouterFallback(): void {
    this.routerFallbacks++;
  }

  getStats(): Stats {
    const uptimeMs = Date.now() - this.startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);

    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);

    return {
      uptimeSeconds,
      uptimeHuman: parts.join(" "),
      totalRequests: this.totalRequests,
      claudeRequests: this.claudeRequests,
      geminiRequests: this.geminiRequests,
      routerErrors: this.routerErrors,
      routerFallbacks: this.routerFallbacks,
    };
  }
}

export const statsCollector = new StatsCollector();
