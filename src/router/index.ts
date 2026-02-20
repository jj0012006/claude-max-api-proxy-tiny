/**
 * Intelligent Router
 *
 * Uses Gemini Flash (via LiteLLM) to classify incoming requests
 * and route them to the most suitable model provider.
 */

import { config } from "../config.js";
import { statsCollector } from "../server/stats.js";

export type RouteDecision = "claude" | "gemini";

const ROUTER_SYSTEM_PROMPT = `You are a task router. Classify the user's request and respond with ONLY one word: "claude" or "gemini".

Route to "gemini" when the task is:
- Mathematical proofs or scientific computation
- Processing very large documents (summarization of long texts)
- Translation between languages
- General knowledge Q&A that doesn't need tool execution
- Data analysis or statistical reasoning

Route to "claude" when the task is:
- Programming, coding, code review, debugging
- Tasks requiring tool execution (running commands, reading/writing files, web search)
- Complex multi-step analysis or research
- Technical writing or documentation
- System administration or DevOps tasks
- Tasks that reference previous conversation context or memory
- Anything unclear or ambiguous (claude is the safe default)

Respond with ONLY "claude" or "gemini". Nothing else.`;

const ROUTER_TIMEOUT_MS = 15000;

/**
 * Route a request to the appropriate model provider.
 *
 * Calls Gemini Flash via LiteLLM to classify the task.
 * Falls back to "claude" on any error or timeout.
 */
export async function routeRequest(userMessage: string): Promise<RouteDecision> {
  if (!config.routerEnabled) {
    return "claude";
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS);

    const response = await fetch(`${config.litellmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.routerModel,
        messages: [
          { role: "system", content: ROUTER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_tokens: 256,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[Router] LiteLLM returned ${response.status}, falling back to claude`);
      statsCollector.recordRouterFallback();
      return "claude";
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const decision = data.choices?.[0]?.message?.content?.trim().toLowerCase();

    if (decision === "gemini") {
      console.error(`[Router] Decision: gemini (message: "${userMessage.slice(0, 80)}")`);
      return "gemini";
    }

    console.error(`[Router] Decision: claude (message: "${userMessage.slice(0, 80)}")`);
    return "claude";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Router] Error: ${message}, falling back to claude`);
    statsCollector.recordRouterError();
    return "claude";
  }
}

/**
 * Check if a model name explicitly targets a specific provider.
 * Returns null if the model should go through the router.
 */
export function getExplicitProvider(model: string): RouteDecision | null {
  const lower = model.toLowerCase();

  // Explicit Gemini models
  if (lower.startsWith("gemini") || lower.includes("gemini")) {
    return "gemini";
  }

  // Explicit Claude models or aliases
  if (
    lower.startsWith("claude") ||
    lower === "opus" ||
    lower === "sonnet" ||
    lower === "haiku" ||
    lower.includes("claude")
  ) {
    return "claude";
  }

  // "auto" or unknown → use router
  if (lower === "auto") {
    return null;
  }

  // Default: claude for any unrecognized model
  return "claude";
}
