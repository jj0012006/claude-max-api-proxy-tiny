/**
 * In-memory statistics collector
 *
 * Tracks request counts and uptime.
 * Stats are lost on process restart (by design — lightweight).
 */

export interface Stats {
  uptimeSeconds: number;
  uptimeHuman: string;
  totalRequests: number;
}

class StatsCollector {
  private startTime = Date.now();
  private totalRequests = 0;

  recordRequest(): void {
    this.totalRequests++;
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
    };
  }
}

export const statsCollector = new StatsCollector();
