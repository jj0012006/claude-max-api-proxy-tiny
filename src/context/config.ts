import type { ContextConfig } from './types.js';

/**
 * Context Manager 默认配置
 */
export const DEFAULT_CONFIG: ContextConfig = {
  windowSize: 30,
  summaryThreshold: 50,
  summaryInterval: 50,
  maxContextTokens: 100000,
  enableRAG: false,
  geminiApiUrl: 'http://localhost:18789/v1/chat/completions',
  geminiModel: 'google/gemini-2.5-flash'
};

/**
 * 从环境变量加载配置
 */
export function loadConfig(overrides?: Partial<ContextConfig>): ContextConfig {
  const config: ContextConfig = { ...DEFAULT_CONFIG };

  // 从环境变量加载
  if (process.env.CONTEXT_WINDOW_SIZE) {
    config.windowSize = parseInt(process.env.CONTEXT_WINDOW_SIZE, 10);
  }
  if (process.env.CONTEXT_SUMMARY_THRESHOLD) {
    config.summaryThreshold = parseInt(process.env.CONTEXT_SUMMARY_THRESHOLD, 10);
  }
  if (process.env.CONTEXT_SUMMARY_INTERVAL) {
    config.summaryInterval = parseInt(process.env.CONTEXT_SUMMARY_INTERVAL, 10);
  }
  if (process.env.CONTEXT_MAX_TOKENS) {
    config.maxContextTokens = parseInt(process.env.CONTEXT_MAX_TOKENS, 10);
  }
  if (process.env.CONTEXT_ENABLE_RAG) {
    config.enableRAG = process.env.CONTEXT_ENABLE_RAG === 'true';
  }
  if (process.env.GEMINI_API_URL) {
    config.geminiApiUrl = process.env.GEMINI_API_URL;
  }
  if (process.env.GEMINI_MODEL) {
    config.geminiModel = process.env.GEMINI_MODEL;
  }

  // 应用显式覆盖
  if (overrides) {
    Object.assign(config, overrides);
  }

  return config;
}
