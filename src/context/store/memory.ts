import type { SessionState, Store } from '../types.js';

/**
 * 内存存储 - 开发/测试用
 * 
 * 特点:
 * - 简单快速
 * - 重启后数据丢失
 * - 适合单机部署
 */
export class MemoryStore implements Store {
  private cache = new Map<string, SessionState>();

  async get(sessionId: string): Promise<SessionState | undefined> {
    return this.cache.get(sessionId);
  }

  async set(sessionId: string, state: SessionState): Promise<void> {
    this.cache.set(sessionId, state);
  }

  async delete(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  /**
   * 清理过期 session
   * @param maxAgeMs 最大存活时间 (毫秒)
   * @returns 清理的 session 数量
   */
  async cleanup(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [sessionId, state] of this.cache.entries()) {
      if (now - state.updatedAt > maxAgeMs) {
        this.cache.delete(sessionId);
        removed++;
      }
    }

    if (removed > 0) {
      console.error(`[MemoryStore] Cleaned up ${removed} expired sessions`);
    }

    return removed;
  }

  /**
   * 获取当前缓存的 session 数量
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * 获取所有 session IDs (用于调试)
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取存储统计 (用于调试/监控)
   */
  getStats(): { size: number; sessionIds: string[] } {
    return {
      size: this.cache.size,
      sessionIds: this.keys()
    };
  }
}
