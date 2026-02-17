/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type {
  OpenAIChatRequest,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAITool,
} from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names
  "claude-opus-4": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-haiku-4": "haiku",
  // With provider prefix
  "claude-code-cli/claude-opus-4": "opus",
  "claude-code-cli/claude-sonnet-4": "sonnet",
  "claude-code-cli/claude-haiku-4": "haiku",
  // Aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^claude-code-cli\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Extract text from OpenAI message content, which can be a string, an array
 * of content parts, or null.
 */
function extractTextContent(content: string | OpenAIContentPart[] | null): string {
  if (content === null || content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("\n");
  }

  return String(content ?? "");
}

/**
 * Format OpenAI tool definitions into a text instruction block for the system prompt.
 * Tells Claude which tools are available and how to invoke them.
 */
function formatToolsForPrompt(
  tools: OpenAITool[],
  toolChoice?: OpenAIChatRequest["tool_choice"]
): string {
  const lines: string[] = [
    "",
    "---",
    "You have the following tools available:",
    "",
  ];

  for (const tool of tools) {
    const fn = tool.function;
    lines.push(`### ${fn.name}`);
    if (fn.description) {
      lines.push(`Description: ${fn.description}`);
    }
    if (fn.parameters) {
      lines.push(`Parameters: ${JSON.stringify(fn.parameters)}`);
    }
    lines.push("");
  }

  lines.push(
    "When you need to use a tool, output EXACTLY this format (do NOT wrap in markdown code blocks):",
    "",
    "<tool_call>",
    '{"name": "tool_name", "arguments": {"param1": "value1"}}',
    "</tool_call>",
    "",
    "Rules:",
    "- You may output multiple <tool_call> blocks if you need to call multiple tools.",
    "- Put any explanatory text BEFORE the <tool_call> block(s).",
    "- The JSON inside <tool_call> must be valid JSON with \"name\" and \"arguments\" fields.",
    "- If you don't need to use any tool, respond normally without <tool_call>.",
  );

  // Handle tool_choice
  if (toolChoice === "none") {
    lines.push("- IMPORTANT: Do NOT use any tools in this response. Respond with text only.");
  } else if (toolChoice === "required") {
    lines.push("- IMPORTANT: You MUST use at least one tool in this response.");
  } else if (typeof toolChoice === "object" && toolChoice?.type === "function") {
    lines.push(`- IMPORTANT: You MUST use the tool "${toolChoice.function.name}" in this response.`);
  }

  return lines.join("\n");
}

/**
 * Format an assistant message that contains tool_calls for inclusion in the prompt.
 */
function formatAssistantWithToolCalls(msg: OpenAIChatMessage): string {
  const parts: string[] = [];
  const text = extractTextContent(msg.content);
  if (text) {
    parts.push(text);
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      parts.push(`[Called tool: ${tc.function.name} with arguments: ${tc.function.arguments}]`);
    }
  }
  return `<previous_response>\n${parts.join("\n")}\n</previous_response>\n`;
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"],
  tools?: OpenAITool[],
  toolChoice?: OpenAIChatRequest["tool_choice"]
): string {
  const parts: string[] = [];
  let hasSystemMessage = false;
  const toolInstruction = tools && tools.length > 0
    ? formatToolsForPrompt(tools, toolChoice)
    : "";

  for (const msg of messages) {
    switch (msg.role) {
      case "system": {
        hasSystemMessage = true;
        const text = extractTextContent(msg.content);
        // Append tool instructions to the system message
        parts.push(`<system>\n${text}${toolInstruction}\n</system>\n`);
        break;
      }

      case "user":
        parts.push(extractTextContent(msg.content));
        break;

      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          parts.push(formatAssistantWithToolCalls(msg));
        } else {
          const text = extractTextContent(msg.content);
          parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        }
        break;

      case "tool": {
        const toolName = msg.name || "unknown";
        const toolCallId = msg.tool_call_id || "unknown";
        const result = extractTextContent(msg.content);
        parts.push(
          `<tool_result name="${toolName}" tool_call_id="${toolCallId}">\n${result}\n</tool_result>\n`
        );
        break;
      }
    }
  }

  // If tools are provided but there was no system message, inject one
  if (toolInstruction && !hasSystemMessage) {
    parts.unshift(`<system>${toolInstruction}\n</system>\n`);
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  return {
    prompt: messagesToPrompt(request.messages, request.tools, request.tool_choice),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
  };
}
