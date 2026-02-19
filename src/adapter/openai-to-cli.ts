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
  sessionId?: string;
  isResuming: boolean;
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

/**
 * Extract the latest user message text from the messages array.
 * Used when resuming an existing session (we only need the new message).
 */
export function extractLatestUserMessage(
  messages: OpenAIChatRequest["messages"]
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return extractTextContent(messages[i].content);
    }
  }
  return "";
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

## YouTube / Video Analysis

When the user sends a YouTube or video URL, use yt-dlp to extract subtitles and analyze the content.
NEVER try to use WebFetch on YouTube video pages — it won't work. Always use yt-dlp.

Step 1 — Download auto-generated subtitles:
\`\`\`bash
yt-dlp --write-auto-sub --sub-lang zh,en --skip-download --sub-format vtt -o "/tmp/%(id)s" "VIDEO_URL"
\`\`\`

Step 2 — Read the subtitle file:
\`\`\`bash
cat /tmp/VIDEO_ID.zh.vtt || cat /tmp/VIDEO_ID.en.vtt
\`\`\`

Step 3 — Summarize the content for the user.

If yt-dlp is not installed, inform the user to install it: pip install yt-dlp
If no subtitles are available, fall back to downloading audio and transcribing with Groq Whisper:
\`\`\`bash
yt-dlp -x --audio-format mp3 -o "/tmp/%(id)s.mp3" "VIDEO_URL"
curl -s https://api.groq.com/openai/v1/audio/transcriptions \\
  -H "Authorization: Bearer $GROQ_API_KEY" \\
  -F "file=@/tmp/VIDEO_ID.mp3" \\
  -F "model=whisper-large-v3-turbo" \\
  -F "response_format=text"
\`\`\`

## Media Delivery

To send any file (image, audio, PDF, etc.) to the user, include a MEDIA: line:
MEDIA: /absolute/path/to/file

## Response Tags

- [[audio_as_voice]] — Send audio file as Telegram voice message
- [[reply_to_current]] — Reply in thread
- HEARTBEAT_OK — Silently acknowledge cron events (no user-visible response)
`.trim();

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

  // Build system prompt: combine system messages + CLI instructions
  let systemPrompt: string | undefined;
  if (systemParts.length > 0) {
    systemPrompt = systemParts.join("\n\n") + "\n\n" + CLI_TOOL_INSTRUCTION;
  } else {
    systemPrompt = CLI_TOOL_INSTRUCTION;
  }

  return {
    prompt: promptParts.join("\n").trim(),
    systemPrompt,
  };
}

/**
 * Convert OpenAI chat request to CLI input format
 *
 * When hasExistingSession is true, we only send the latest user message
 * as the prompt (the CLI already has the conversation context from the session),
 * and we skip the system prompt (already set in the existing session).
 */
export function openaiToCli(
  request: OpenAIChatRequest,
  hasExistingSession: boolean = false
): CliInput {
  if (hasExistingSession) {
    // Resuming an existing session: only send the latest user message
    const latestMessage = extractLatestUserMessage(request.messages);
    return {
      prompt: latestMessage,
      systemPrompt: undefined, // CLI already has system prompt from session
      model: extractModel(request.model),
      sessionId: request.user,
      isResuming: true,
    };
  }

  // New session: send full conversation context
  const converted = messagesToPrompt(request.messages);
  return {
    prompt: converted.prompt,
    systemPrompt: converted.systemPrompt,
    model: extractModel(request.model),
    sessionId: request.user,
    isResuming: false,
  };
}
