import type { OpenAIChatMessage } from '../types/openai.js';

/**
 * Session 状态 - 跟踪每个对话的上下文管理状态
 */
export interface SessionState {
  sessionId: string;
  turnCount: number;
  summary?: string;
  summaryTokenCount: number;
  lastSummaryTurn: number;
  vectorIds: string[];  // 预留 RAG 支持
  createdAt: number;
  updatedAt: number;
}

/**
 * Context Manager 配置
 */
export interface ContextConfig {
  /** 滑动窗口大小 - 保留最近 N 轮对话 (默认 30) */
  windowSize: number;
  /** 触发摘要的阈值 (默认 50) */
  summaryThreshold: number;
  /** 摘要更新间隔 (默认 50) */
  summaryInterval: number;
  /** 最大上下文 token 数 (默认 100000) */
  maxContextTokens: number;
  /** 是否启用 RAG 检索 (默认 false) */
  enableRAG: boolean;
  /** Gemini API 地址 (用于生成摘要) */
  geminiApiUrl: string;
  /** Gemini 模型 ID */
  geminiModel: string;
}

/**
 * Context 处理结果
 */
export interface ContextResult {
  messages: OpenAIChatMessage[];
  tokenCount: number;
  originalTokenCount: number;
  savedTokenCount: number;
  savingsPercent: number;
  strategy: {
    windowApplied: boolean;
    summaryApplied: boolean;
    ragApplied: boolean;
  };
}

/**
 * Store 接口 - 抽象存储层
 */
export interface Store {
  get(sessionId: string): Promise<SessionState | undefined>;
  set(sessionId: string, state: SessionState): Promise<void>;
  delete(sessionId: string): Promise<void>;
  clear(): Promise<void>;
  cleanup(maxAgeMs: number): Promise<number>;
}

/**
 * 摘要生成策略接口
 */
export interface SummaryStrategy {
  shouldSummarize(turnCount: number, lastSummaryTurn: number, threshold: number): boolean;
  generateSummary(messages: OpenAIChatMessage[], geminiApiUrl: string, geminiModel: string): Promise<string>;
  buildContextWithSummary(
    systemMessages: OpenAIChatMessage[],
    summary: string,
    recentMessages: OpenAIChatMessage[]
  ): OpenAIChatMessage[];
}

/**
 * 滑动窗口策略接口
 */
export interface WindowStrategy {
  apply(messages: OpenAIChatMessage[], windowSize: number): OpenAIChatMessage[];
}
