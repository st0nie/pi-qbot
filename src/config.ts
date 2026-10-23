import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BotConfig {
	appId: string;
	secret: string;
	sandbox: boolean;
	/** Root dir; each conversation gets <root>/groups/<openid> or <root>/users/<openid> */
	root: string;
	/** Bot persona name/description injected into the system prompt */
	name: string;
	persona: string;
	/** Allow C2C private chats too */
	allowPrivate: boolean;
	/** Optional allowlist of group openids (empty = all) */
	groups: string[];
	/** Optional "provider/model" for conversation sessions */
	model?: string;
	/** Thinking level for conversation sessions (off|minimal|low|medium|high|xhigh) */
	thinking?: string;
	/** Debounce window to batch rapid messages (ms) */
	debounceMs: number;
}

/**
 * Load config from <cwd>/qqbot.json (or .pi/qqbot.json), with env overrides
 * QQBOT_APP_ID / QQBOT_SECRET / QQBOT_SANDBOX.
 */
export function loadConfig(cwd: string): BotConfig | undefined {
	let file: Partial<BotConfig> = {};
	for (const p of [join(cwd, "qqbot.json"), join(cwd, ".pi", "qqbot.json")]) {
		if (existsSync(p)) {
			file = JSON.parse(readFileSync(p, "utf8"));
			break;
		}
	}
	const appId = process.env.QQBOT_APP_ID ?? file.appId;
	const secret = process.env.QQBOT_SECRET ?? file.secret;
	if (!appId || !secret) return undefined;
	return {
		appId: String(appId),
		secret: String(secret),
		sandbox: process.env.QQBOT_SANDBOX ? process.env.QQBOT_SANDBOX === "1" : !!file.sandbox,
		root: file.root ? String(file.root) : cwd,
		name: file.name ?? "QBot",
		persona: file.persona ?? "",
		allowPrivate: file.allowPrivate ?? true,
		groups: Array.isArray(file.groups) ? file.groups.map(String) : [],
		model: file.model,
		thinking: file.thinking,
		debounceMs: file.debounceMs ?? 1500,
	};
}
