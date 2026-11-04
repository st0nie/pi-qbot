/**
 * pi-qbot: official QQ Bot bridge for pi.
 *
 * Run `pi` in a root directory containing qqbot.json. All chats share that
 * workspace, persona and realctx project, while each group/private chat keeps
 * its own transcript, refs and inbox under groups/<openid>/ or users/<openid>/.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BotConfig, loadConfig } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { type InboundMessage, QQClient, QQGateway } from "./qq.ts";

// Process-wide singleton so /reload or session switches don't open duplicate sockets.
// SAFETY: globalThis is a plain object; we only read/write our own namespaced key.
const G = globalThis as unknown as { __piQbot?: Bridge };

class Bridge {
	readonly client: QQClient;
	readonly gateway: QQGateway;
	readonly convs = new Map<string, Conversation>();
	private seen = new Set<string>();
	logs: string[] = [];
	ui?: ExtensionContext["ui"];
	/** Host pi model/thinking, mirrored into every conversation session. */
	host: { model?: Model<any>; thinking?: string } = {};

	setHost(h: { model?: Model<any>; thinking?: string }): void {
		this.host = { ...this.host, ...h };
		for (const c of this.convs.values()) void c.setHost(h).catch((e) => this.log(`setHost failed: ${e}`));
	}

	constructor(readonly cfg: BotConfig) {
		this.client = new QQClient(cfg.appId, cfg.secret, cfg.sandbox);
		this.gateway = new QQGateway(this.client, (m) => this.onMessage(m), (s) => this.log(s));
	}

	log(s: string): void {
		const line = `${new Date().toLocaleTimeString("en-GB", { hour12: false })} ${s}`;
		this.logs.push(line.replace(/\s+/g, " "));
		if (this.logs.length > 300) this.logs.shift();
		const ctxs = [...this.convs.values()].map((c) => `${c.tag}=${c.usage() ?? "idle"}`);
		const shown = ctxs.length > 4 ? [...ctxs.slice(0, 4), `+${ctxs.length - 4}`] : ctxs;
		this.ui?.setStatus("qqbot", `QQ: ${this.gateway?.state ?? "?"} · ${this.convs.size} chats${shown.length ? ` · ${shown.join(" · ")}` : ""}`);
		// Live chat feed in the host TUI: incoming, replies, tool calls, thoughts.
		this.ui?.setWidget(
			"qqbot-feed",
			this.logs.slice(-8).map((l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l)),
		);
	}

	private onMessage(m: InboundMessage): void {
		// GROUP_AT and GROUP_MESSAGE may both deliver the same message id.
		if (this.seen.has(m.id)) return;
		this.seen.add(m.id);
		if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
		if (m.type === "c2c" && !this.cfg.allowPrivate) return;
		if (m.type === "group" && this.cfg.groups.length && !this.cfg.groups.includes(m.convId)) return;
		const key = `${m.type}:${m.convId}`;
		let conv = this.convs.get(key);
		if (!conv) {
			conv = new Conversation(m.type, m.convId, this.cfg, this.client, (s) => this.log(s));
			conv.host = { ...this.host };
			this.convs.set(key, conv);
		}
		void conv.push(m).catch((e) => this.log(`[${m.convId.slice(0, 8)}] push failed: ${(e as Error).message}`));
	}

	async stop(): Promise<void> {
		this.gateway.stop();
		await Promise.all([...this.convs.values()].map((c) => c.dispose()));
		this.convs.clear();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("qqbot", { description: "Start the QQ bot bridge (needs qqbot.json in cwd)", type: "boolean" });

	pi.on("session_start", async (_e, ctx) => {
		if (G.__piQbot) {
			G.__piQbot.ui = ctx.ui;
			G.__piQbot.setHost({ model: ctx.model, thinking: pi.getThinkingLevel() });
			return;
		}
		// Opt-in only: start with `pi --qqbot` (or `/qqbot start` later).
		if (!pi.getFlag("qqbot")) return;
		const cfg = loadConfig(ctx.cwd);
		if (!cfg) {
			ctx.ui.notify("--qqbot: no qqbot.json (or QQBOT_APP_ID/QQBOT_SECRET) in this directory", "error");
			return;
		}
		const bridge = new Bridge(cfg);
		bridge.ui = ctx.ui;
		bridge.host = { model: ctx.model, thinking: pi.getThinkingLevel() };
		G.__piQbot = bridge;
		bridge.gateway.start();
		bridge.log("qqbot starting");
	});

	// Follow the host pi: model / thinking switches apply to all chat sessions.
	pi.on("model_select", async (e) => G.__piQbot?.setHost({ model: e.model }));
	pi.on("thinking_level_select", async (e: any) => G.__piQbot?.setHost({ thinking: e.level }));

	pi.registerCommand("qqbot", {
		description: "QQ bot: status | logs [N] | restart | stop | start",
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = (args.trim() || "status").split(/\s+/);
			let b = G.__piQbot;
			const launch = (): Bridge | undefined => {
				const cfg = loadConfig(ctx.cwd);
				if (!cfg) {
					ctx.ui.notify("no qqbot.json / QQBOT_APP_ID in cwd", "error");
					return undefined;
				}
				const nb = new Bridge(cfg);
				nb.ui = ctx.ui;
				nb.host = { model: ctx.model, thinking: pi.getThinkingLevel() };
				G.__piQbot = nb;
				nb.gateway.start();
				nb.log("qqbot starting");
				return nb;
			};
			if (sub === "restart") {
				if (b) {
					await b.stop();
					G.__piQbot = undefined;
				}
				b = launch();
				if (b) return ctx.ui.notify("qqbot restarted", "info");
				return;
			}
			if (sub === "start") {
				if (b) return ctx.ui.notify("already running", "info");
				b = launch();
				if (b) return ctx.ui.notify("qqbot started", "info");
				return;
			}
			if (!b) return ctx.ui.notify("qqbot not running", "warning");
			if (sub === "stop") {
				await b.stop();
				G.__piQbot = undefined;
				ctx.ui.setStatus("qqbot", undefined);
				return ctx.ui.notify("qqbot stopped", "info");
			}
			if (sub === "logs") {
				const requested = Number(rest[0] ?? 30);
				const count = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 30;
				return ctx.ui.notify(b.logs.slice(-count).join("\n") || "(no logs)", "info");
			}
			if (sub !== "status" && sub !== "chats") return ctx.ui.notify("usage: /qqbot status | logs [N] | restart | stop | start", "warning");
			const chats = [...b.convs.values()]
				.map((c) => `  ${c.type}:${c.tag} ${c.usage() ?? "(idle)"} ${c.dir}`)
				.join("\n");
			ctx.ui.notify(
				`bot: ${b.cfg.name}\ngateway: ${b.gateway.state}\nshared workspace/persona: ${b.cfg.root}\nchats:\n${chats || "  (none)"}`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async (e) => {
		// Keep the process-wide bridge across reload/session switches; only quit tears it down.
		if (e.reason !== "quit" || !G.__piQbot) return;
		await G.__piQbot.stop();
		G.__piQbot = undefined;
	});
}
