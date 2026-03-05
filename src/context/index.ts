/**
 * Context Manager - 上下文管理模块
 * 
 * 功能:
 * - 滑动窗口：保留最近 N 轮对话
 * - 摘要压缩：定期生成对话摘要
 * - Token 优化：减少上下文 token 消耗
 * - 状态管理：跟踪每个 session 的状态
 * 
 * 使用示例:
 * ```typescript
 * import { ContextManager } from './context/index.js';
 * 
 * const manager = new ContextManager({
 *   windowSize: 30,
 *   summaryThreshold: 50
 * });
 * 
 * const result = await manager.processContext(sessionId, messages);
 * console.log(`Saved ${result.savingsPercent}% tokens`);
 * ```
 */

export { ContextManager, getContextManager, resetContextManager } from './manager.js';
export { loadConfig, DEFAULT_CONFIG } from './config.js';
export { MemoryStore } from './store/memory.js';
export { SlidingWindowStrategy, countTurns, estimateTokens } from './strategies/window.js';
export { SummaryCompressionStrategy, getEarlyMessages } from './strategies/summary.js';

export type {
  SessionState,
  ContextConfig,
  ContextResult,
  Store,
  SummaryStrategy,
  WindowStrategy
} from './types.js';
