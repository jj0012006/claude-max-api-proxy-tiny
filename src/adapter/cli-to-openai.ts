/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type {
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIToolCall,
} from "../types/openai.js";

// --- Tool call parsing ---

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * Generate a short random ID for tool calls
 */
function generateToolCallId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "call_";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export interface ParsedToolResponse {
  textContent: string | null;
  toolCalls: OpenAIToolCall[];
}

/**
 * Parse tool calls from CLI response text.
 * Looks for <tool_call>{"name":"...","arguments":{...}}</tool_call> patterns.
 */
export function parseToolCalls(text: string): ParsedToolResponse {
  const toolCalls: OpenAIToolCall[] = [];

  // Find text before the first <tool_call> tag
  const firstTagIndex = text.indexOf("<tool_call>");
  const textBefore = firstTagIndex >= 0
    ? text.substring(0, firstTagIndex).trim()
    : text.trim();

  // Extract all tool call blocks
  let match: RegExpExecArray | null;
  // Reset regex state
  TOOL_CALL_REGEX.lastIndex = 0;
  while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
    const jsonStr = match[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.name && typeof parsed.name === "string") {
        toolCalls.push({
          id: generateToolCallId(),
          type: "function",
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      console.error("[parseToolCalls] Failed to parse tool call JSON:", jsonStr.slice(0, 200));
    }
  }

  // If no tool calls found, return original text as-is
  if (toolCalls.length === 0) {
    return { textContent: text, toolCalls: [] };
  }

  return {
    textContent: textBefore || null,
    toolCalls,
  };
}

// --- Streaming chunk builders ---

/**
 * Build an array of SSE chunks for a tool-calling response.
 * Used by the buffered streaming handler.
 */
export function buildToolCallChunks(
  parsed: ParsedToolResponse,
  requestId: string,
  model: string
): OpenAIChatChunk[] {
  const chunks: OpenAIChatChunk[] = [];
  const now = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${requestId}`;
  const normalizedModel = normalizeModelName(model);

  // 1. If there's text content, send it first
  if (parsed.textContent) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created: now,
      model: normalizedModel,
      choices: [{
        index: 0,
        delta: { role: "assistant", content: parsed.textContent },
        finish_reason: null,
      }],
    });
  }

  // 2. Send each tool call as delta chunks
  for (let i = 0; i < parsed.toolCalls.length; i++) {
    const tc = parsed.toolCalls[i];

    // First chunk for this tool call: id + name
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created: now,
      model: normalizedModel,
      choices: [{
        index: 0,
        delta: {
          // Only set role on the very first chunk if no text content was sent
          role: i === 0 && !parsed.textContent ? "assistant" : undefined,
          tool_calls: [{
            index: i,
            id: tc.id,
            type: "function",
            function: { name: tc.function.name },
          }],
        },
        finish_reason: null,
      }],
    });

    // Second chunk: arguments
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created: now,
      model: normalizedModel,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i,
            function: { arguments: tc.function.arguments },
          }],
        },
        finish_reason: null,
      }],
    });
  }

  // 3. Final chunk with finish_reason
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: now,
    model: normalizedModel,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: "tool_calls",
    }],
  });

  return chunks;
}

// --- Existing functions ---

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response (text only)
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string
): OpenAIChatResponse {
  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.result,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response with tool call detection.
 * If the response contains <tool_call> blocks, returns tool_calls format.
 * Otherwise falls back to regular text response.
 */
export function cliResultToOpenaiWithTools(
  result: ClaudeCliResult,
  requestId: string
): OpenAIChatResponse {
  const parsed = parseToolCalls(result.result);

  // No tool calls found — return regular text response
  if (parsed.toolCalls.length === 0) {
    return cliResultToOpenai(result, requestId);
  }

  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: parsed.textContent,
          tool_calls: parsed.toolCalls,
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
export function normalizeModelName(model: string): string {
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
