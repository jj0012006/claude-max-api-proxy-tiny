/**
 * Bot Persona Configuration
 *
 * Loads per-bot personas from ~/.openclaw/bots.json.
 * Each persona maps to a Discord channel (or user pattern)
 * and provides isolated system prompt, workspace, and memory.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// --- Types ---

export interface BotPersonaConfig {
  name: string;
  /** Discord channel IDs or other identifiers to match against body.user */
  channels?: string[];
  /** Regex patterns to match against body.user */
  userPatterns?: string[];
  /** Extra system prompt prepended to CLI_TOOL_INSTRUCTION */
  systemPrompt?: string | null;
  /** Custom CLAUDE.md content for workspace seeding */
  claudeMd?: string | null;
  /** Override default model for this persona */
  defaultModel?: string | null;
}

export interface BotPersona extends BotPersonaConfig {
  id: string;
}

interface BotsConfigFile {
  bots: Record<string, BotPersonaConfig>;
}

// --- Default persona (matches current behavior) ---

export const DEFAULT_PERSONA: BotPersona = {
  id: "default",
  name: "Default",
  channels: [],
  userPatterns: [],
  systemPrompt: null,
  claudeMd: null,
  defaultModel: null,
};

// --- Config loading with mtime cache ---

const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "bots.json");

let configCache: BotsConfigFile | null = null;
let configMtime: number = 0;

function loadBotsConfig(): BotsConfigFile | null {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (configCache && stat.mtimeMs === configMtime) {
      return configCache;
    }

    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as BotsConfigFile;

    if (!parsed.bots || typeof parsed.bots !== "object") {
      console.error("[BotConfig] Invalid bots.json: missing 'bots' object");
      return null;
    }

    configCache = parsed;
    configMtime = stat.mtimeMs;
    console.error(`[BotConfig] Loaded ${Object.keys(parsed.bots).length} persona(s) from bots.json`);
    return configCache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No config file — that's fine, use defaults
      return null;
    }
    console.error(`[BotConfig] Error loading bots.json: ${(err as Error).message}`);
    return null;
  }
}

// --- Persona resolution ---

/**
 * Resolve which bot persona a request belongs to based on body.user.
 * Returns DEFAULT_PERSONA if no match or no config file.
 */
export function resolvePersona(user: string): BotPersona {
  if (!user) return DEFAULT_PERSONA;

  const config = loadBotsConfig();
  if (!config) return DEFAULT_PERSONA;

  for (const [id, bot] of Object.entries(config.bots)) {
    // Match by channel ID (substring match in user field)
    for (const channelId of bot.channels || []) {
      if (user.includes(channelId)) {
        console.error(`[BotConfig] Matched persona "${id}" by channel ${channelId}`);
        return { ...bot, id };
      }
    }

    // Match by regex pattern
    for (const pattern of bot.userPatterns || []) {
      try {
        if (new RegExp(pattern).test(user)) {
          console.error(`[BotConfig] Matched persona "${id}" by pattern /${pattern}/`);
          return { ...bot, id };
        }
      } catch {
        // Bad regex, skip
      }
    }
  }

  return DEFAULT_PERSONA;
}
