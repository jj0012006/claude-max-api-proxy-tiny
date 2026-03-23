/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type {
  OpenAIChatRequest,
  OpenAIContentPart,
} from "../types/openai.js";
export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  systemPrompt?: string;
  model: ClaudeModel;
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
  // With maxproxy prefix
  "maxproxy/claude-opus-4": "opus",
  "maxproxy/claude-sonnet-4": "sonnet",
  "maxproxy/claude-haiku-4": "haiku",
  // With claude-max prefix
  "claude-max/claude-opus-4": "opus",
  "claude-max/claude-sonnet-4": "sonnet",
  "claude-max/claude-haiku-4": "haiku",
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

  // Try stripping provider prefix (any prefix before /)
  const stripped = model.replace(/^[^/]+\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Try matching full Claude model names (e.g., claude-sonnet-4-5-20250929)
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";

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
 * XML tool tag patterns used by Claude CLI in assistant messages.
 * These are internal tool execution results that should not be sent
 * back to the CLI in conversation history.
 */
const TOOL_TAG_PATTERNS = [
  // Bash tool
  { pattern: /<Bash>[\s\S]*?<\/Bash>/g, label: "Ran command" },
  // Read/Write/Edit tools
  { pattern: /<read>[\s\S]*?<\/read>/g, label: "Read file" },
  { pattern: /<write>[\s\S]*?<\/write>/g, label: "Wrote file" },
  { pattern: /<edit>[\s\S]*?<\/edit>/g, label: "Edited file" },
  // Browser/Web tools
  { pattern: /<browser>[\s\S]*?<\/browser>/g, label: "Browsed web" },
  { pattern: /<WebFetch>[\s\S]*?<\/WebFetch>/g, label: "Fetched URL" },
  { pattern: /<WebSearch>[\s\S]*?<\/WebSearch>/g, label: "Web search" },
  // Platform tools
  { pattern: /<Message>[\s\S]*?<\/Message>/g, label: "Sent message" },
  { pattern: /<Cron>[\s\S]*?<\/Cron>/g, label: "Cron task" },
  { pattern: /<Canvas>[\s\S]*?<\/Canvas>/g, label: "Canvas" },
  { pattern: /<Sessions>[\s\S]*?<\/Sessions>/g, label: "Sessions" },
  // Generic tool_use XML blocks
  { pattern: /<tool_use>[\s\S]*?<\/tool_use>/g, label: "Tool use" },
  // Antml function calls
  { pattern: /<function_calls>[\s\S]*?<\/antml:function_calls>/g, label: "Tool use" },
];

/**
 * Clean assistant message content by removing XML tool patterns.
 * Replaces tool blocks with short summaries to keep context concise.
 */
export function cleanAssistantContent(text: string): string {
  let cleaned = text;
  const summaries: string[] = [];

  for (const { pattern, label } of TOOL_TAG_PATTERNS) {
    const matches = cleaned.match(pattern);
    if (matches) {
      for (const _match of matches) {
        summaries.push(`[${label}]`);
      }
      cleaned = cleaned.replace(pattern, "");
    }
  }

  // Collapse 4+ consecutive summaries
  if (summaries.length >= 4) {
    cleaned = cleaned.trim();
    if (cleaned) {
      cleaned += `\n[Executed ${summaries.length} tool operations]`;
    } else {
      cleaned = `[Executed ${summaries.length} tool operations]`;
    }
  } else if (summaries.length > 0) {
    cleaned = cleaned.trim();
    const summaryText = summaries.join(" ");
    if (cleaned) {
      cleaned += `\n${summaryText}`;
    } else {
      cleaned = summaryText;
    }
  }

  return cleaned.trim();
}

export interface ConvertedMessages {
  prompt: string;
  systemPrompt?: string;
}

/**
 * Strip OpenClaw's "## Tooling" section from the system prompt.
 *
 * OpenClaw injects a tool list (read, write, exec, sessions_spawn, etc.) into
 * the system prompt, but the actual execution environment is Claude CLI which
 * has its own tools (Read, Write, Bash, etc.). The OpenClaw tool names cause
 * "No such tool available" errors because Claude CLI doesn't recognize them.
 *
 * We replace the section with a mapping note so the LLM uses the correct names.
 */
function cleanSystemPromptForCli(systemPrompt: string): string {
  // Match the "## Tooling" section up to the next "##" heading or end
  const toolingSectionRegex = /## Tooling\n[\s\S]*?(?=\n## |\n---|\Z)/;

  if (!toolingSectionRegex.test(systemPrompt)) {
    return systemPrompt;
  }

  const replacement = `## Tooling
IMPORTANT: You are running inside Claude Code CLI. Use Claude CLI tool names (case-sensitive):
- Bash: Run shell commands (replaces "exec")
- Read: Read file contents (replaces "read")
- Write: Create or overwrite files (replaces "write")
- Edit: Make precise edits to files (replaces "edit")
- Glob: Find files by pattern
- Grep: Search file contents
- WebSearch: Search the web (replaces "web_search")
- WebFetch: Fetch URL content (replaces "web_fetch")
- Agent: Spawn sub-agent (replaces "sessions_spawn")

Tools NOT available in this environment: canvas, nodes, cron, message, gateway,
sessions_list, sessions_history, sessions_send, subagents, session_status,
memory_get, memory_search, agents_list, browser.
If your task requires these tools, complete what you can and report limitations.`;

  return systemPrompt.replace(toolingSectionRegex, replacement);
}

/**
 * Convert OpenAI messages array to a prompt string and a separate system prompt.
 *
 * System messages are extracted and returned as `systemPrompt` so they can be
 * passed to CLI via `--system-prompt` (proper role separation).
 * All other messages are formatted into the prompt text.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): ConvertedMessages {
  const systemParts: string[] = [];
  const promptParts: string[] = [];

  for (const msg of messages) {
    // Skip tool result messages
    if (msg.role === "tool") continue;

    switch (msg.role) {
      case "system": {
        systemParts.push(extractTextContent(msg.content));
        break;
      }

      case "user":
        promptParts.push(extractTextContent(msg.content));
        break;

      case "assistant": {
        // Skip assistant messages that only have tool_calls and no text content
        if ((msg as unknown as Record<string, unknown>).tool_calls && !msg.content) continue;

        const text = extractTextContent(msg.content);
        if (!text.trim()) continue;

        // Clean XML tool patterns from assistant content
        const cleaned = cleanAssistantContent(text);
        if (cleaned) {
          promptParts.push(`<previous_response>\n${cleaned}\n</previous_response>\n`);
        }
        break;
      }
    }
  }

  // Clean OpenClaw tool references from system prompt so the LLM uses
  // Claude CLI's actual tool names instead of getting "No such tool" errors
  const systemPrompt = systemParts.length > 0
    ? cleanSystemPromptForCli(systemParts.join("\n\n"))
    : undefined;

  const prompt = promptParts.join("\n").trim();

  // Log prompt size for monitoring token consumption
  console.log(
    `[prompt-size] messages=${messages.length} system=${systemPrompt?.length ?? 0}chars prompt=${prompt.length}chars`
  );

  return {
    prompt,
    systemPrompt,
  };
}

/**
 * Extract the latest user message for --resume mode.
 * Only the new message needs to be sent; CLI loads history from session.
 */
export function extractLatestUserMessage(messages: OpenAIChatRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return extractTextContent(messages[i].content);
    }
  }
  return "";
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const converted = messagesToPrompt(request.messages);
  return {
    prompt: converted.prompt,
    systemPrompt: converted.systemPrompt,
    model: extractModel(request.model),
  };
}
