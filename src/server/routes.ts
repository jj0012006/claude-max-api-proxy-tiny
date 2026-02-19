/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import type { SubprocessOptions } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent, ClaudeCliMessage } from "../types/claude-cli.js";
import { isMessageStart, isContentBlockStart } from "../types/claude-cli.js";
import { routeRequest, getExplicitProvider } from "../router/index.js";
import { handleGeminiStreaming, handleGeminiNonStreaming } from "../provider/gemini.js";
import { extractLatestUserMessage } from "../adapter/openai-to-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // --- Routing: decide which provider handles this request ---
    const explicitProvider = getExplicitProvider(body.model);
    let provider = explicitProvider;

    if (!provider) {
      // model is "auto" or unrecognized — use intelligent routing
      const latestMsg = extractLatestUserMessage(body.messages);
      provider = await routeRequest(latestMsg);
    }

    // --- Gemini path ---
    if (provider === "gemini") {
      console.error(`[Route] → Gemini (model: ${body.model})`);
      if (stream) {
        await handleGeminiStreaming(res, body.messages, body.model, requestId);
      } else {
        await handleGeminiNonStreaming(res, body.messages, body.model, requestId);
      }
      return;
    }

    // --- Claude path (existing flow) ---
    console.error(`[Route] → Claude (model: ${body.model})`);

    // Session persistence: look up or create a session for this conversation
    const conversationId = body.user || requestId;
    const existingSession = sessionManager.get(conversationId);
    const hasExistingSession = !!existingSession;
    const resumeSessionId = existingSession?.claudeSessionId;

    // Convert to CLI input format (uses hasExistingSession to decide prompt strategy)
    const cliInput = openaiToCli(body, hasExistingSession);
    const subprocess = new ClaudeSubprocess();

    const claudeSessionId = sessionManager.getOrCreate(conversationId, cliInput.model);
    sessionManager.incrementMessageCount(conversationId);

    // Build subprocess options with session and system prompt
    const subprocessOpts: SubprocessOptions = {
      model: cliInput.model,
      sessionId: claudeSessionId,
      resumeSessionId,
      systemPrompt: cliInput.systemPrompt,
    };

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, subprocessOpts, cliInput.prompt, requestId, conversationId);
    } else {
      await handleNonStreamingResponse(res, subprocess, subprocessOpts, cliInput.prompt, requestId, conversationId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Telegram Progress Reporter
 *
 * Sends tool execution progress updates via Telegram Bot API.
 * Reads bot token from ~/.openclaw/openclaw.json (cached).
 */
let cachedBotToken: string | null = null;
let botTokenLoaded = false;

async function getTelegramBotToken(): Promise<string | null> {
  if (botTokenLoaded) return cachedBotToken;
  botTokenLoaded = true;

  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const data = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(data);
    // Look for Telegram bot token in various config locations
    cachedBotToken =
      config.telegram?.botToken ||
      config.telegram?.token ||
      config.integrations?.telegram?.botToken ||
      null;
  } catch {
    cachedBotToken = null;
  }
  return cachedBotToken;
}

async function telegramApi(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const token = await getTelegramBotToken();
  if (!token) return null;

  try {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return await response.json();
  } catch (err) {
    console.error(`[TelegramApi] ${method} failed:`, err);
    return null;
  }
}

class ProgressReporter {
  private chatId: string | undefined;
  private progressMessageId: number | null = null;
  private lastReportTime: number = 0;
  private toolNames: string[] = [];
  private static THROTTLE_MS = 3000;

  constructor(chatId?: string) {
    this.chatId = chatId;
  }

  async reportToolUse(toolName: string): Promise<void> {
    if (!this.chatId) return;

    this.toolNames.push(toolName);
    const now = Date.now();
    if (now - this.lastReportTime < ProgressReporter.THROTTLE_MS) return;
    this.lastReportTime = now;

    const text = `⏳ Working... [${this.toolNames.join(" → ")}]`;

    try {
      if (this.progressMessageId) {
        await telegramApi("editMessageText", {
          chat_id: this.chatId,
          message_id: this.progressMessageId,
          text,
        });
      } else {
        const result = (await telegramApi("sendMessage", {
          chat_id: this.chatId,
          text,
        })) as { result?: { message_id?: number } } | null;
        if (result?.result?.message_id) {
          this.progressMessageId = result.result.message_id;
        }
      }
    } catch {
      // Non-critical, ignore errors
    }
  }

  async cleanup(): Promise<void> {
    if (!this.chatId || !this.progressMessageId) return;
    try {
      await telegramApi("deleteMessage", {
        chat_id: this.chatId,
        message_id: this.progressMessageId,
      });
    } catch {
      // Non-critical
    }
    this.progressMessageId = null;
  }
}

/**
 * Handle streaming response (SSE) with Smart Turn Buffering
 *
 * Smart Turn Buffering: Claude CLI executes multiple "turns" when using tools.
 * Each turn is marked by a message_start event. We buffer content deltas and
 * only forward the content from the LAST turn to the client. This prevents
 * intermediate tool execution output from leaking to the user.
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  options: SubprocessOptions,
  prompt: string,
  requestId: string,
  conversationId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  // Extract Telegram chat ID for progress reporting (if available in metadata)
  const telegramChatId = (req.body as Record<string, unknown>).telegram_chat_id as string | undefined;
  const progressReporter = new ProgressReporter(telegramChatId);

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;

    // Smart Turn Buffering state
    let currentTurnDeltas: string[] = [];
    let turnCount = 0;

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      progressReporter.cleanup();
      resolve();
    });

    // Handle resume failure — invalidate the bad session
    subprocess.on("resume_failed", (_sessionId: string) => {
      console.error(`[Streaming] Resume failed, invalidating session for: ${conversationId}`);
      sessionManager.invalidate(conversationId);
    });

    // Track message_start events (each one = new turn)
    subprocess.on("message", (msg: ClaudeCliMessage) => {
      if (isMessageStart(msg)) {
        // New turn started — clear the buffer (discard previous turn's content)
        turnCount++;
        currentTurnDeltas = [];
        console.error(`[Streaming] Turn ${turnCount} started`);
      }

      // Track tool use for progress reporting
      if (isContentBlockStart(msg)) {
        const event = msg as ClaudeCliStreamEvent;
        if (event.event.content_block?.type === "tool_use" && event.event.content_block.name) {
          const toolName = event.event.content_block.name;
          console.error(`[Streaming] Tool use: ${toolName}`);
          progressReporter.reportToolUse(toolName);
        }
      }
    });

    // Buffer content deltas instead of sending immediately
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      if (text) {
        currentTurnDeltas.push(text);
      }
    });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (_result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        // Flush the last turn's buffered content to the client
        for (const text of currentTurnDeltas) {
          const chunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: lastModel,
            choices: [{
              index: 0,
              delta: {
                role: isFirst ? "assistant" : undefined,
                content: text,
              },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          isFirst = false;
        }

        // Append model tag
        const tagChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: { content: "\n\n🟣 Claude" },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(tagChunk)}\n\n`);

        // Send final done chunk with finish_reason
        const doneChunk = createDoneChunk(requestId, lastModel);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      progressReporter.cleanup();
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      progressReporter.cleanup();
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      progressReporter.cleanup();
      resolve();
    });

    // Start the subprocess
    subprocess.start(prompt, options).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  options: SubprocessOptions,
  prompt: string,
  requestId: string,
  conversationId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    // Handle resume failure
    subprocess.on("resume_failed", (_sessionId: string) => {
      console.error(`[NonStreaming] Resume failed, invalidating session for: ${conversationId}`);
      sessionManager.invalidate(conversationId);
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        const response = cliResultToOpenai(finalResult, requestId);
        if (response.choices[0]?.message?.content) {
          response.choices[0].message.content += "\n\n🟣 Claude";
        }
        res.json(response);
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(prompt, options)
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-opus-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-sonnet-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-haiku-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "gemini-pro",
        object: "model",
        owned_by: "google",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "gemini-flash",
        object: "model",
        owned_by: "google",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "auto",
        object: "model",
        owned_by: "proxy",
        created: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
