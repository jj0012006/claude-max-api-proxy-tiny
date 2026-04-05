/**
 * CLI Session Store
 *
 * Maps proxy session IDs (derived from system message hash) to
 * Claude CLI session IDs for --resume support.
 * File-backed storage with 24-hour TTL and periodic cleanup.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface CliSession {
  cliSessionId: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PERSIST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "sessions.json"
);

export class SessionStore {
  private sessions = new Map<string, CliSession>();
  private cleanupTimer: NodeJS.Timeout;
  private persistDebounce: NodeJS.Timeout | null = null;

  constructor() {
    this.loadFromDisk();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if timer is active
    this.cleanupTimer.unref();
  }

  get(proxySessionId: string): CliSession | undefined {
    const session = this.sessions.get(proxySessionId);
    if (!session) return undefined;

    if (Date.now() - session.lastUsedAt > TTL_MS) {
      this.sessions.delete(proxySessionId);
      this.schedulePersist();
      return undefined;
    }

    session.lastUsedAt = Date.now();
    this.schedulePersist();
    return session;
  }

  set(proxySessionId: string, session: CliSession): void {
    this.sessions.set(proxySessionId, session);
    this.schedulePersist();
  }

  delete(proxySessionId: string): void {
    this.sessions.delete(proxySessionId);
    this.schedulePersist();
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
      this.persistToDisk();
    }
  }

  private schedulePersist(): void {
    if (this.persistDebounce) return;
    this.persistDebounce = setTimeout(() => {
      this.persistDebounce = null;
      this.persistToDisk();
    }, 2000); // debounce 2s to avoid excessive writes
    this.persistDebounce.unref();
  }

  private persistToDisk(): void {
    try {
      const data: Record<string, CliSession> = {};
      for (const [id, session] of this.sessions) {
        data[id] = session;
      }
      writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[SessionStore] Failed to persist sessions:`, err);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(PERSIST_PATH)) return;
      const raw = readFileSync(PERSIST_PATH, "utf-8");
      const data: Record<string, CliSession> = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      let expired = 0;
      for (const [id, session] of Object.entries(data)) {
        if (now - session.lastUsedAt > TTL_MS) {
          expired++;
          continue;
        }
        this.sessions.set(id, session);
        loaded++;
      }
      console.error(`[SessionStore] Loaded ${loaded} sessions from disk (${expired} expired, skipped)`);
    } catch (err) {
      console.error(`[SessionStore] Failed to load sessions from disk:`, err);
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
