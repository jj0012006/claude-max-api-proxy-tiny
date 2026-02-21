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
 * Strip model tags (🟣 Claude, 🟢 Gemini) from message content
 * to prevent models from copying these tags in their responses.
 */
function stripModelTags(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && typeof msg.content === "string") {
      return {
        ...msg,
        content: msg.content.replace(/\n*🟣\s*\S.*$/g, "").replace(/\n*🟢\s*\S.*$/g, ""),
      };
    }
    return msg;
  });
}

/**
 * Prepare messages for Gemini: strip model tags and inject system message
 * to prevent the model from generating its own tags.
 */
function prepareGeminiMessages(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const cleaned = stripModelTags(messages);
  // Inject system message to prevent Gemini from copying model tag patterns
  return [
    {
      role: "system",
      content: "Never append emoji model tags (like 🟣 or 🟢 followed by a model name) at the end of your responses.",
    },
    ...cleaned,
  ];
}

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
        messages: prepareGeminiMessages(messages),
        stream: true,
        tools: [{ googleSearch: {} }],
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

    // Stream SSE from LiteLLM to client, intercepting [DONE] to insert tag
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let actualModel = geminiModel;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      if (!res.writableEnded) {
        // Try to extract actual model name from the first chunk
        if (actualModel === geminiModel) {
          const modelMatch = chunk.match(/"model"\s*:\s*"([^"]+)"/);
          if (modelMatch) actualModel = modelMatch[1];
        }

        // Intercept [DONE] — insert our tag before it
        if (chunk.includes("data: [DONE]")) {
          const before = chunk.replace(/data: \[DONE\]\n?\n?/g, "");
          if (before.trim()) {
            res.write(before);
          }
          // Insert Gemini tag with actual model name
          const tagChunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: actualModel,
            choices: [{
              index: 0,
              delta: { content: `\n\n🟢 ${actualModel}` },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(tagChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
        } else {
          res.write(chunk);
        }
      }
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
        messages: prepareGeminiMessages(messages),
        stream: false,
        tools: [{ googleSearch: {} }],
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
    const actualModel = (result.model as string) || geminiModel;
    const choices = (result.choices as Array<{ message?: { content?: string } }>) || [];
    if (choices[0]?.message?.content) {
      // Strip any model-generated tags before appending our own
      choices[0].message.content = choices[0].message.content
        .replace(/\n*🟣\s*\S.*$/g, "")
        .replace(/\n*🟢\s*\S.*$/g, "");
      choices[0].message.content += `\n\n🟢 ${actualModel}`;
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
