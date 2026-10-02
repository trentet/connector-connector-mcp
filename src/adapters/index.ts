import type { Platform } from "../core/types.js";
import { chatgptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { grokAdapter } from "./grok.js";
import type { PlatformAdapter } from "./types.js";

/** Registered platform adapters. A platform without an entry reports "not-implemented". */
export const ADAPTERS: Partial<Record<Platform, PlatformAdapter>> = { claude: claudeAdapter(), grok: grokAdapter(), chatgpt: chatgptAdapter() };
