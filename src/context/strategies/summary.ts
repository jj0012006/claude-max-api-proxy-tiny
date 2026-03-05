import type { OpenAIChatMessage } from '../../types/openai.js';
import type { SummaryStrategy } from '../types.js';

/**
 * 摘要压缩策略 - 使用 Gemini Flash 生成对话摘要
 * 
 * 核心逻辑:
 * 1. 每 N 轮触发一次摘要生成
 * 2. 摘要保留关键决策、技术选型、待办事项
 * 3. 异步生成，不阻塞当前请求
 */
export class SummaryCompressionStrategy implements SummaryStrategy {
  /**
   * 判断是否需要生成摘要
   */
  shouldSummarize(
    turnCount: number,
    lastSummaryTurn: number,
    threshold: number
  ): boolean {
    // 总轮次达到阈值 且 距离上次摘要已超过阈值
    return turnCount >= threshold && (turnCount - lastSummaryTurn) >= threshold;
  }

  /**
   * 生成对话摘要
   * 调用 Gemini Flash (便宜快速)
   */
  async generateSummary(
    messages: OpenAIChatMessage[],
    geminiApiUrl: string,
    geminiModel: string
  ): Promise<string> {
    const systemPrompt = `请摘要以下对话，保留以下内容:

1. **关键决策和技术选型** - 用户做出的重要决定
2. **已完成的任务** - 已经完成的工作
3. **待办事项和悬而未决的问题** - 还需要处理的事情
4. **用户偏好和约束条件** - 用户的特殊要求

要求:
- 用中文
- 限制在 500 字内
- 使用简洁的条目式格式
- 只保留重要信息，忽略寒暄和冗余内容

摘要格式示例:
【技术选型】Node.js + TypeScript + PostgreSQL
【已完成】项目初始化、数据库设计、API 接口开发
【待办】前端页面开发、部署配置
【用户偏好】偏好简洁代码，重视类型安全`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(geminiApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: geminiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ],
          max_tokens: 600
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      const summary = data.choices?.[0]?.message?.content;

      if (!summary) {
        throw new Error('No summary content in response');
      }

      return summary;
    } catch (error) {
      console.error('[SummaryStrategy] Summary generation failed:', error);
      throw error;
    }
  }

  /**
   * 构建带摘要的上下文
   */
  buildContextWithSummary(
    systemMessages: OpenAIChatMessage[],
    summary: string,
    recentMessages: OpenAIChatMessage[]
  ): OpenAIChatMessage[] {
    const summaryMessage: OpenAIChatMessage = {
      role: 'system',
      content: `【对话摘要】${summary}\n\n以上是之前对话的摘要。以下是最近的对话内容，请基于以上摘要和最近对话继续:`
    };

    return [...systemMessages, summaryMessage, ...recentMessages];
  }
}

/**
 * 工具函数：获取早期对话 (用于摘要生成)
 * 排除最近 windowSize 轮，只处理早期对话
 */
export function getEarlyMessages(messages: OpenAIChatMessage[], windowSize: number): OpenAIChatMessage[] {
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  
  if (nonSystemMessages.length <= windowSize) {
    return []; // 没有早期对话
  }

  const earlyMessages = nonSystemMessages.slice(0, -windowSize);
  return [...systemMessages, ...earlyMessages];
}
