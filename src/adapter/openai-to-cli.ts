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
  systemPrompt?: string;
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
 * Built-in CLI tool instructions.
 * Tells the model how to use CLI native tools (bash, file ops, etc.)
 * and how to handle voice/audio messages via Groq Whisper.
 */
const CLI_TOOL_INSTRUCTION = `
---
## CLI Native Tools

You are running inside Claude Code CLI with full tool access.
ALWAYS use the Bash tool to run shell commands. NEVER output shell commands as plain text.

Available native tools: Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch.

## Voice/Audio Message Handling

When you receive a message referencing an audio file (e.g. a .ogg, .mp3, .wav file path),
you MUST use the Bash tool to transcribe it. NEVER guess or hallucinate what the user said.

Use Groq Whisper API for transcription:
\`\`\`bash
curl -s https://api.groq.com/openai/v1/audio/transcriptions \\
  -H "Authorization: Bearer $GROQ_API_KEY" \\
  -F "file=@/path/to/audio.ogg" \\
  -F "model=whisper-large-v3-turbo" \\
  -F "response_format=text"
\`\`\`

After transcription, process the text content and respond to the user.
If $GROQ_API_KEY is not set, inform the user that voice transcription is not configured.

## Media Delivery

To send any file (image, audio, PDF, etc.) to the user, include a MEDIA: line:
MEDIA: /absolute/path/to/file

## Response Tags

- [[audio_as_voice]] — Send audio file as Telegram voice message
- [[reply_to_current]] — Reply in thread
- HEARTBEAT_OK — Silently acknowledge cron events (no user-visible response)
`.trim();

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

export interface ConvertedMessages {
  prompt: string;
  systemPrompt?: string;
}

/**
 * Convert OpenAI messages array to a prompt string and a separate system prompt.
 *
 * System messages are extracted and returned as `systemPrompt` so they can be
 * passed to CLI via `--system-prompt` (proper role separation).
 * All other messages are formatted into the prompt text.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"],
  tools?: OpenAITool[],
  toolChoice?: OpenAIChatRequest["tool_choice"]
): ConvertedMessages {
  const systemParts: string[] = [];
  const promptParts: string[] = [];
  const toolInstruction = tools && tools.length > 0
    ? formatToolsForPrompt(tools, toolChoice)
    : "";

  for (const msg of messages) {
    switch (msg.role) {
      case "system": {
        systemParts.push(extractTextContent(msg.content));
        break;
      }

      case "user":
        promptParts.push(extractTextContent(msg.content));
        break;

      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          promptParts.push(formatAssistantWithToolCalls(msg));
        } else {
          const text = extractTextContent(msg.content);
          promptParts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        }
        break;

      case "tool": {
        const toolName = msg.name || "unknown";
        const toolCallId = msg.tool_call_id || "unknown";
        const result = extractTextContent(msg.content);
        promptParts.push(
          `<tool_result name="${toolName}" tool_call_id="${toolCallId}">\n${result}\n</tool_result>\n`
        );
        break;
      }
    }
  }

  // Build system prompt: combine system messages + CLI instructions + tool instructions
  let systemPrompt: string | undefined;
  const hasContent = systemParts.length > 0 || toolInstruction;
  if (hasContent) {
    systemPrompt = systemParts.join("\n\n");
    // Always append CLI tool instruction (voice handling, media delivery, etc.)
    systemPrompt += "\n\n" + CLI_TOOL_INSTRUCTION;
    if (toolInstruction) {
      systemPrompt += toolInstruction;
    }
    systemPrompt = systemPrompt.trim() || undefined;
  } else {
    // Even without system messages or tools, inject CLI instructions
    systemPrompt = CLI_TOOL_INSTRUCTION;
  }

  return {
    prompt: promptParts.join("\n").trim(),
    systemPrompt,
  };
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const converted = messagesToPrompt(request.messages, request.tools, request.tool_choice);
  return {
    prompt: converted.prompt,
    systemPrompt: converted.systemPrompt,
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
  };
}
