import type { OpenAIChatMessage } from '../../types/openai.js';
import type { WindowStrategy } from '../types.js';

/**
 * 滑动窗口策略 - 保留最近 N 轮对话
 * 
 * 核心逻辑:
 * 1. 始终保留所有 system messages
 * 2. 非 system 消息保留最近 windowSize 轮
 */
export class SlidingWindowStrategy implements WindowStrategy {
  apply(messages: OpenAIChatMessage[], windowSize: number): OpenAIChatMessage[] {
    if (!messages || messages.length === 0) {
      return messages;
    }

    // 分离 system 和非 system 消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // 如果非 system 消息不超过窗口大小，直接返回
    if (nonSystemMessages.length <= windowSize) {
      return messages;
    }

    // 保留最近 windowSize 轮
    const recentMessages = nonSystemMessages.slice(-windowSize);

    console.error(`[WindowStrategy] Applied sliding window: ${nonSystemMessages.length} → ${recentMessages.length} messages`);

    return [...systemMessages, ...recentMessages];
  }
}

/**
 * 工具函数：计算对话轮次
 * 一轮 = 1 个 user 消息 + 1 个 assistant 消息
 */
export function countTurns(messages: OpenAIChatMessage[]): number {
  const userMessages = messages.filter(m => m.role === 'user');
  return userMessages.length;
}

/**
 * 工具函数：估算 token 数
 * 简单算法：平均 4 字符/token (中文略少，英文略多)
 */
export function estimateTokens(messages: OpenAIChatMessage[]): number {
  const totalChars = messages.reduce((sum, m) => {
    if (typeof m.content === 'string') {
      return sum + m.content.length;
    }
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s: number, c: any) => {
        if (typeof c === 'string') return s + c.length;
        if (c.type === 'text') return s + (c.text?.length || 0);
        return s;
      }, 0);
    }
    return sum;
  }, 0);

  // 4 字符/token 是粗略估算
  return Math.ceil(totalChars / 4);
}
