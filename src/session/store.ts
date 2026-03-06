/**
 * CLI Session Store
 *
 * Maps proxy session IDs (derived from system message hash) to
 * Claude CLI session IDs for --resume support.
 * In-memory storage with 24-hour TTL and periodic cleanup.
 */

export interface CliSession {
  cliSessionId: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class SessionStore {
  private sessions = new Map<string, CliSession>();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if timer is active
    this.cleanupTimer.unref();
  }

  get(proxySessionId: string): CliSession | undefined {
    const session = this.sessions.get(proxySessionId);
    if (!session) return undefined;

    if (Date.now() - session.lastUsedAt > TTL_MS) {
      this.sessions.delete(proxySessionId);
      return undefined;
    }

    session.lastUsedAt = Date.now();
    return session;
  }

  set(proxySessionId: string, session: CliSession): void {
    this.sessions.set(proxySessionId, session);
  }

  delete(proxySessionId: string): void {
    this.sessions.delete(proxySessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt > TTL_MS) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.error(`[SessionStore] Cleaned up ${removed} expired sessions, ${this.sessions.size} remaining`);
    }
  }
}

// Singleton
let instance: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!instance) {
    instance = new SessionStore();
  }
  return instance;
}
