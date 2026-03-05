import type { OpenAIChatMessage } from '../types/openai.js';
import type { SessionState, ContextConfig, ContextResult, Store } from './types.js';
import { loadConfig, DEFAULT_CONFIG } from './config.js';
import { SlidingWindowStrategy, estimateTokens } from './strategies/window.js';
import { SummaryCompressionStrategy, getEarlyMessages } from './strategies/summary.js';
import { MemoryStore } from './store/memory.js';

/**
 * Context Manager - 核心上下文管理器
 * 
 * 职责:
 * 1. 滑动窗口 - 保留最近 N 轮对话
 * 2. 摘要压缩 - 定期生成对话摘要
 * 3. 状态管理 - 跟踪每个 session 的状态
 * 4. Token 优化 - 减少上下文 token 消耗
 */
export class ContextManager {
  private config: ContextConfig;
  private store: Store;
  private windowStrategy: SlidingWindowStrategy;
  private summaryStrategy: SummaryCompressionStrategy;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(overrides?: Partial<ContextConfig>) {
    this.config = loadConfig(overrides);
    this.store = new MemoryStore(); // 可替换为 RedisStore
    this.windowStrategy = new SlidingWindowStrategy();
    this.summaryStrategy = new SummaryCompressionStrategy();

    // 启动定期清理 (每 30 分钟清理 24 小时未活跃的 session)
    this.startCleanupTask();

    console.error(`[ContextManager] Initialized with config: windowSize=${this.config.windowSize}, summaryThreshold=${this.config.summaryThreshold}`);
  }

  /**
   * 处理上下文 - 核心方法
   * 
   * @param sessionId - 会话 ID
   * @param messages - 原始消息数组
   * @returns 处理后的上下文结果
   */
  async processContext(
    sessionId: string,
    messages: OpenAIChatMessage[]
  ): Promise<ContextResult> {
    const startTime = Date.now();

    // 获取或创建 session 状态
    let state = await this.store.get(sessionId);
    if (!state) {
      state = this.createInitialState(sessionId);
    }

    // 更新轮次计数
    state.turnCount++;
    state.updatedAt = Date.now();

    // 估算原始 token 数
    const originalTokenCount = estimateTokens(messages);

    // 分离 system 和非 system 消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // 策略 1: 滑动窗口
    const windowedMessages = this.windowStrategy.apply(
      nonSystemMessages,
      this.config.windowSize
    );

    // 策略 2: 摘要压缩 (条件触发)
    let summary = state.summary;
    const shouldSummarize = this.summaryStrategy.shouldSummarize(
      state.turnCount,
      state.lastSummaryTurn,
      this.config.summaryThreshold
    );

    if (shouldSummarize && !state.summary) {
      // 首次达到摘要阈值，生成摘要
      console.error(`[ContextManager] First summary triggered at turn ${state.turnCount}`);
    } else if (shouldSummarize) {
      // 定期更新摘要
      console.error(`[ContextManager] Summary update triggered at turn ${state.turnCount}`);
    }

    if (shouldSummarize) {
      // 异步生成摘要 (不阻塞当前请求)
      this.generateSummaryAsync(sessionId, state, messages);
      // 当前请求仍用旧摘要 (下次生效)
    }

    // 构建最终上下文
    const finalMessages = summary
      ? this.summaryStrategy.buildContextWithSummary(
          systemMessages,
          summary,
          windowedMessages
        )
      : [...systemMessages, ...windowedMessages];

    // 计算处理后的 token 数
    const tokenCount = estimateTokens(finalMessages);
    const savedTokenCount = originalTokenCount - tokenCount;
    const savingsPercent = originalTokenCount > 0 
      ? Math.round((savedTokenCount / originalTokenCount) * 100) 
      : 0;

    // 保存状态
    await this.store.set(sessionId, state);

    const duration = Date.now() - startTime;

    console.error(
      `[ContextManager] Processed context for ${sessionId}: ` +
      `turn=${state.turnCount}, tokens=${originalTokenCount}→${tokenCount} ` +
      `(${savingsPercent}% saved), duration=${duration}ms`
    );

    return {
      messages: finalMessages,
      tokenCount,
      originalTokenCount,
      savedTokenCount,
      savingsPercent,
      strategy: {
        windowApplied: windowedMessages.length < nonSystemMessages.length,
        summaryApplied: !!summary,
        ragApplied: false
      }
    };
  }

  /**
   * 异步生成摘要 (后台任务，不阻塞)
   */
  private async generateSummaryAsync(
    sessionId: string,
    state: SessionState,
    messages: OpenAIChatMessage[]
  ): Promise<void> {
    setImmediate(async () => {
      try {
        // 获取早期对话用于摘要
        const earlyMessages = getEarlyMessages(messages, this.config.windowSize);
        
        if (earlyMessages.length === 0) {
          console.error(`[ContextManager] No early messages to summarize for ${sessionId}`);
          return;
        }

        const summary = await this.summaryStrategy.generateSummary(
          earlyMessages,
          this.config.geminiApiUrl,
          this.config.geminiModel
        );

        state.summary = summary;
        state.lastSummaryTurn = state.turnCount;
        state.summaryTokenCount = estimateTokens([{ role: 'system', content: summary }]);

        await this.store.set(sessionId, state);

        console.error(
          `[ContextManager] Summary updated for ${sessionId} ` +
          `(turn ${state.turnCount}, ${state.summaryTokenCount} tokens)`
        );
      } catch (error) {
        console.error(`[ContextManager] Summary generation failed for ${sessionId}:`, error);
        // 失败不影响主流程，下次再试
      }
    });
  }

  /**
   * 创建初始 session 状态
   */
  private createInitialState(sessionId: string): SessionState {
    return {
      sessionId,
      turnCount: 0,
      summaryTokenCount: 0,
      lastSummaryTurn: 0,
      vectorIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  /**
   * 清除 session
   */
  async clearSession(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
    console.error(`[ContextManager] Cleared session ${sessionId}`);
  }

  /**
   * 获取 session 状态
   */
  async getSessionState(sessionId: string): Promise<SessionState | undefined> {
    return await this.store.get(sessionId);
  }

  /**
   * 获取所有活跃 session IDs
   */
  async getActiveSessionIds(): Promise<string[]> {
    if (this.store instanceof MemoryStore) {
      return this.store.keys();
    }
    // 其他 store 实现可能需要不同方法
    return [];
  }

  /**
   * 获取存储统计
   */
  getStoreStats(): { size: number; sessionIds: string[] } {
    if (this.store instanceof MemoryStore) {
      return this.store.getStats();
    }
    return { size: 0, sessionIds: [] };
  }

  /**
   * 启动定期清理任务
   */
  private startCleanupTask(): void {
    // 每 30 分钟清理一次 24 小时未活跃的 session
    const cleanupIntervalMs = 30 * 60 * 1000;
    const maxAgeMs = 24 * 60 * 60 * 1000;

    this.cleanupInterval = setInterval(async () => {
      try {
        const removed = await this.store.cleanup(maxAgeMs);
        if (removed > 0) {
          console.error(`[ContextManager] Cleanup: removed ${removed} expired sessions`);
        }
      } catch (error) {
        console.error('[ContextManager] Cleanup failed:', error);
      }
    }, cleanupIntervalMs);

    console.error(`[ContextManager] Cleanup task started (interval=${cleanupIntervalMs / 1000}s, maxAge=${maxAgeMs / 1000 / 60 / 60}h)`);
  }

  /**
   * 停止清理任务 (用于优雅关闭)
   */
  stopCleanupTask(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
      console.error('[ContextManager] Cleanup task stopped');
    }
  }

  /**
   * 清空所有状态 (用于测试)
   */
  async clearAll(): Promise<void> {
    await this.store.clear();
    console.error('[ContextManager] All sessions cleared');
  }
}

// 单例实例 (可选，方便全局访问)
let globalInstance: ContextManager | undefined;

export function getContextManager(overrides?: Partial<ContextConfig>): ContextManager {
  if (!globalInstance) {
    globalInstance = new ContextManager(overrides);
  }
  return globalInstance;
}

export function resetContextManager(): void {
  if (globalInstance) {
    globalInstance.stopCleanupTask();
    globalInstance = undefined;
  }
}
