/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration.
 * Supports --resume for session continuity (only sends new messages after first request).
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import type { SubprocessOptions } from "../subprocess/manager.js";
import { openaiToCli, extractLatestUserMessage, extractModel } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent, ClaudeCliMessage } from "../types/claude-cli.js";
import { isMessageStart, isContentBlockStart } from "../types/claude-cli.js";
import { statsCollector } from "./stats.js";
import { getSessionStore } from "../session/store.js";

// CLI Session Store (singleton)
const sessionStore = getSessionStore();

/**
 * Derive a stable session ID from the system message content.
 * Hashes the full first system message — different agents produce different hashes.
 */
function deriveSessionId(messages: OpenAIChatRequest['messages']): string | undefined {
  const systemMsg = messages.find(m => m.role === 'system');
  if (!systemMsg?.content) return undefined;

  const text = typeof systemMsg.content === 'string'
    ? systemMsg.content
    : JSON.stringify(systemMsg.content);

  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming.
 * Uses --resume for subsequent requests from the same session.
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  // Session ID: explicit header > derived from system message hash > random UUID
  const sessionId = req.headers['x-session-id'] as string
    || deriveSessionId(body.messages)
    || uuidv4();

  console.error(`[Route] session=${sessionId}`);

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

    statsCollector.recordRequest();

    const cliSession = sessionStore.get(sessionId);
    const isResume = !!cliSession;
    let prompt: string;
    let subprocessOpts: SubprocessOptions;

    if (isResume) {
      // Resume mode: only send latest user message, CLI loads history from session
      prompt = extractLatestUserMessage(body.messages);
      subprocessOpts = {
        model: extractModel(body.model),
        resumeSessionId: cliSession.cliSessionId,
      };
      console.error(`[Route] → Claude RESUME (model: ${body.model}, cliSession: ${cliSession.cliSessionId}, prompt: ${prompt.length} chars)`);
    } else {
      // New session: send full context
      const cliInput = openaiToCli(body);
      prompt = cliInput.prompt;
      subprocessOpts = {
        model: cliInput.model,
        systemPrompt: cliInput.systemPrompt,
        sessionId: uuidv4(),
      };
      console.error(`[Route] → Claude NEW (model: ${body.model}, cliSession: ${subprocessOpts.sessionId}, prompt: ${prompt.length} chars)`);
    }

    const subprocess = new ClaudeSubprocess();

    // Set response headers
    res.setHeader('x-session-id', sessionId);
    res.setHeader('x-resume', isResume ? 'true' : 'false');

    if (stream) {
      await handleStreamingResponse(res, subprocess, subprocessOpts, prompt, requestId, sessionId);
    } else {
      await handleNonStreamingResponse(res, subprocess, subprocessOpts, prompt, requestId, sessionId);
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
 * Handle streaming response (SSE) with Smart Turn Buffering
 *
 * Smart Turn Buffering: Claude CLI executes multiple "turns" when using tools.
 * Each turn is marked by a message_start event. We buffer content deltas and
 * only forward the content from the LAST turn to the client.
 */
async function handleStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  options: SubprocessOptions,
  prompt: string,
  requestId: string,
  proxySessionId?: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // Flush headers immediately to establish SSE connection
  res.flushHeaders();
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;

    // Smart Turn Buffering state
    let currentTurnDeltas: string[] = [];
    let turnCount = 0;

    // SSE keepalive every 30s during long tool execution
    const keepaliveInterval = setInterval(() => {
      if (!isComplete && !res.writableEnded) {
        res.write(":keepalive\n\n");
      }
    }, 30_000);

    // Handle client disconnect
    res.on("close", () => {
      clearInterval(keepaliveInterval);
      if (!isComplete) {
        subprocess.kill();
      }
      resolve();
    });

    // Track message_start events (each one = new turn)
    subprocess.on("message", (msg: ClaudeCliMessage) => {
      if (isMessageStart(msg)) {
        turnCount++;
        currentTurnDeltas = [];
        console.error(`[Streaming] Turn ${turnCount} started`);
      }

      if (isContentBlockStart(msg)) {
        const event = msg as ClaudeCliStreamEvent;
        if (event.event.content_block?.type === "tool_use" && event.event.content_block.name) {
          console.error(`[Streaming] Tool use: ${event.event.content_block.name}`);
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

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      clearInterval(keepaliveInterval);

      // Capture CLI session ID for future --resume
      if (proxySessionId && result.session_id) {
        sessionStore.set(proxySessionId, {
          cliSessionId: result.session_id,
          model: lastModel,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
        console.error(`[Streaming] Session stored: proxy=${proxySessionId} → cli=${result.session_id}`);
      }

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

        // Send final done chunk
        const doneChunk = createDoneChunk(requestId, lastModel);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      clearInterval(keepaliveInterval);
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      clearInterval(keepaliveInterval);

      // Resume failed — only clear session on definitive errors (exit code 1/2),
      // NOT on SIGTERM (143) or activity timeout, since the CLI session file is
      // still valid and can be resumed. Clearing on timeout causes a cascade:
      // next request becomes NEW with full context → slow + wastes tokens.
      if (code !== 0 && !isComplete && options.resumeSessionId && proxySessionId) {
        if (code !== null && code < 128) {
          // Real error (code 1, 2, etc.) — session is likely corrupt, clear it
          console.error(`[Streaming] Resume failed (code=${code}), clearing session ${proxySessionId}`);
          sessionStore.delete(proxySessionId);
        } else {
          // Signal kill (143=SIGTERM, 137=SIGKILL) or timeout — keep session for retry
          console.error(`[Streaming] Resume interrupted (code=${code}), keeping session ${proxySessionId} for retry`);
        }
      }

      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
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
  proxySessionId?: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;

      // Capture CLI session ID for future --resume
      if (proxySessionId && result.session_id) {
        sessionStore.set(proxySessionId, {
          cliSessionId: result.session_id,
          model: options.model,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
      }
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
      // Resume failed — only clear on real errors, not signal kills
      if (code !== 0 && !finalResult && options.resumeSessionId && proxySessionId) {
        if (code !== null && code < 128) {
          sessionStore.delete(proxySessionId);
        }
      }

      if (finalResult) {
        const response = cliResultToOpenai(finalResult, requestId);
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

    subprocess.start(prompt, options).catch((error) => {
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
    ],
  });
}

/**
 * Handle GET /health
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
