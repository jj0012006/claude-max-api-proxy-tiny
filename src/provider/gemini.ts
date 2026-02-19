/**
 * Gemini Provider
 *
 * Forwards requests to Gemini models via LiteLLM's OpenAI-compatible API.
 * Supports both streaming (SSE) and non-streaming responses.
 */

import type { Response } from "express";
import { config } from "../config.js";
import type { OpenAIChatMessage } from "../types/openai.js";

/**
 * Map model names to LiteLLM model identifiers
 */
function resolveGeminiModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("flash")) return "gemini-flash";
  if (lower.includes("pro")) return "gemini-pro";
  return config.geminiDefaultModel;
}

/**
 * Handle a streaming Gemini request via LiteLLM.
 * Transparently proxies SSE events from LiteLLM to the client.
 */
export async function handleGeminiStreaming(
  res: Response,
  messages: OpenAIChatMessage[],
  model: string,
  requestId: string
): Promise<void> {
  const geminiModel = resolveGeminiModel(model);

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Provider", "gemini");
  res.flushHeaders();
  res.write(":ok\n\n");

  try {
    const response = await fetch(`${config.litellmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: geminiModel,
        messages,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[Gemini] LiteLLM error ${response.status}: ${errorText}`);
      res.write(
        `data: ${JSON.stringify({
          error: {
            message: `Gemini provider error: ${response.status}`,
            type: "server_error",
            code: null,
          },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Stream SSE from LiteLLM to client
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      if (!res.writableEnded) {
        res.write(chunk);
      }
    }

    // Append Gemini model tag before closing stream
    if (!res.writableEnded) {
      const tagChunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: geminiModel,
        choices: [{
          index: 0,
          delta: { content: "\n\n🟢 Gemini" },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(tagChunk)}\n\n`);
    }

    // Ensure stream is properly closed
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Gemini] Streaming error:", message);
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          error: { message, type: "server_error", code: null },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

/**
 * Handle a non-streaming Gemini request via LiteLLM.
 * Waits for the full response and returns it as JSON.
 */
export async function handleGeminiNonStreaming(
  res: Response,
  messages: OpenAIChatMessage[],
  model: string,
  requestId: string
): Promise<void> {
  const geminiModel = resolveGeminiModel(model);

  try {
    const response = await fetch(`${config.litellmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: geminiModel,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[Gemini] LiteLLM error ${response.status}: ${errorText}`);
      res.status(response.status).json({
        error: {
          message: `Gemini provider error: ${errorText}`,
          type: "server_error",
          code: null,
        },
      });
      return;
    }

    const data = await response.json();

    // Override response metadata
    const result = data as Record<string, unknown>;
    result.id = `chatcmpl-${requestId}`;

    // Append Gemini model tag to response content
    const choices = (result.choices as Array<{ message?: { content?: string } }>) || [];
    if (choices[0]?.message?.content) {
      choices[0].message.content += "\n\n🟢 Gemini";
    }

    res.setHeader("X-Provider", "gemini");
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Gemini] Non-streaming error:", message);
    res.status(500).json({
      error: {
        message,
        type: "server_error",
        code: null,
      },
    });
  }
}
