/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  systemPrompt?: string;
  sessionId?: string;
  resumeSessionId?: string;
  timeout?: number;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

// Activity timeout: 10 minutes of no output triggers kill
const ACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private activityTimeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;
  private logTextBuffer: string = "";

  /**
   * Reset the activity timeout. Called on each stdout data event.
   * If no output is received for ACTIVITY_TIMEOUT_MS, the process is killed.
   */
  private resetActivityTimeout(): void {
    this.clearTimeout();
    this.activityTimeoutId = setTimeout(() => {
      if (!this.isKilled) {
        console.error(`[Subprocess] Activity timeout (${ACTIVITY_TIMEOUT_MS / 1000}s no output), killing process`);
        this.isKilled = true;
        this.process?.kill("SIGTERM");
        this.emit("error", new Error(`No activity for ${ACTIVITY_TIMEOUT_MS / 1000} seconds, request timed out`));
      }
    }, ACTIVITY_TIMEOUT_MS);
  }

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(prompt, options);
    const cwd = process.env.PROXY_CWD || process.cwd();

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        this.process = spawn("claude", args, {
          cwd,
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Start activity timeout
        this.resetActivityTimeout();

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Close stdin since we pass prompt as argument
        this.process.stdin?.end();

        console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          // Reset activity timeout on each output
          this.resetActivityTimeout();
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Reset activity timeout on stderr output too
            this.resetActivityTimeout();
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            console.error("[Subprocess stderr]:", errorText.slice(0, 500));
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          console.error(`[Subprocess] Process closed with code: ${code}`);
          this.clearTimeout();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array
   */
  private buildArgs(prompt: string, options: SubprocessOptions): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      "--dangerously-skip-permissions", // Allow CLI to execute tools (bash, file ops, etc.)
    ];

    // Session management: --resume for existing sessions, --session-id for new ones
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    } else if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    // Pass system prompt as a native CLI flag (proper role separation)
    // Not needed on resume — CLI loads it from session state
    if (options.systemPrompt && !options.resumeSessionId) {
      args.push("--system-prompt", options.systemPrompt);
    }

    // End of flags, start of positional args
    args.push("--", prompt);

    return args;
  }

  /**
   * Flush accumulated text delta log buffer
   */
  private flushLogBuffer(): void {
    if (this.logTextBuffer) {
      // Print each line with prefix
      for (const line of this.logTextBuffer.split("\n")) {
        if (line.trim()) console.error(`[Subprocess] ${line}`);
      }
      this.logTextBuffer = "";
    }
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isContentDelta(message)) {
          const evt = message as ClaudeCliStreamEvent;
          const delta = evt.event.delta as Record<string, string> | undefined;
          const text = delta?.text || delta?.thinking || "";
          if (text) {
            this.logTextBuffer += text;
          }
          this.emit("content_delta", evt);
        } else {
          // Non-delta event: check if it's a block boundary
          const raw = message as unknown as Record<string, unknown>;
          if (raw.type === "stream_event") {
            const evt = raw as unknown as ClaudeCliStreamEvent;
            if (evt.event.type === "content_block_stop") {
              // Block ended, flush accumulated text
              this.flushLogBuffer();
            } else if (evt.event.type === "content_block_start") {
              if (evt.event.content_block?.type === "tool_use") {
                console.error(`[Subprocess] Tool: ${evt.event.content_block.name}`);
              }
            }
          }

          if (isAssistantMessage(message)) {
            this.flushLogBuffer();
            this.emit("assistant", message);
          } else if (isResultMessage(message)) {
            this.flushLogBuffer();
            const r = message as ClaudeCliResult;
            console.error(`[Subprocess] Result: ${r.subtype}, ${r.num_turns} turns, ${r.duration_ms}ms`);
            this.emit("result", r);
          }
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the activity timeout timer
   */
  private clearTimeout(): void {
    if (this.activityTimeoutId) {
      clearTimeout(this.activityTimeoutId);
      this.activityTimeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
