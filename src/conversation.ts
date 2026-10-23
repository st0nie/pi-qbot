import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { BotConfig } from "./config.ts";
import { personaPrompt } from "./prompt.ts";
import { StickerLibrary } from "./stickers.ts";
import type { ConvType, InboundMessage, QQClient } from "./qq.ts";

type Log = (s: string) => void;
type Image = { type: "image"; data: string; mimeType: string };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const PASSIVE_WINDOW_MS = 4.5 * 60 * 1000;

/** One QQ group / private chat = one directory = one persistent pi session. */
export class Conversation {
	readonly dir: string;
	private session?: AgentSession;
	private initPromise?: Promise<AgentSession>;
	private pending: { lines: string[]; images: Image[] } = { lines: [], images: [] };
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	/** Latest inbound msg used as passive-reply anchor */
	private anchor?: { id: string; at: number; seq: number };
	private names = new Map<string, string>();
	/** Short transcript refs (#N) -> QQ message ids, for quote replies. */
	private refs = new Map<number, string>();
	private refSeq = 0;
	private sentThisRun = 0;
	private lastThinking?: string;
	readonly stickers: StickerLibrary;

	constructor(
		readonly type: ConvType,
		readonly convId: string,
		readonly cfg: BotConfig,
		private readonly qq: QQClient,
		readonly log: Log,
	) {
		this.dir = resolve(cfg.root, type === "group" ? "groups" : "users", convId);
		mkdirSync(join(this.dir, "inbox"), { recursive: true });
		this.stickers = new StickerLibrary(cfg.root);
		const memo = join(this.dir, "MEMORY.md");
		if (!existsSync(memo)) writeFileSync(memo, "# Memory\n\n(Members, nicknames, running jokes, agreements.)\n");
	}

	// ---------- inbound ----------

	async push(m: InboundMessage): Promise<void> {
		this.anchor = { id: m.id, at: Date.now(), seq: 1 };
		if (m.authorName) this.names.set(m.authorId, m.authorName);
		for (const men of m.mentions) if (men.name && !men.isMe) this.names.set(men.id, men.name);
		const ref = ++this.refSeq;
		this.refs.set(ref, m.id);
		if (this.refs.size > 500) this.refs.delete(this.refs.keys().next().value!);
		const line = await this.format(m, ref);
		this.pending.lines.push(line.text);
		this.log(`[${this.convId.slice(0, 8)}] ${line.text.slice(0, 140)}`);
		this.pending.images.push(...line.images);
		// Answer faster when directly addressed; otherwise wait a bit to batch chatter.
		const delay = m.mentionedMe || this.type === "c2c" ? 600 : this.cfg.debounceMs;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), delay);
	}

	private async format(m: InboundMessage, ref: number): Promise<{ text: string; images: Image[] }> {
		const time = new Date(m.timestamp).toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Shanghai" });
		let content = decodeFaces(m.text)
			.replace(/<@!?([^>]+)>/g, (_all, id: string) => {
				if (id === "all") return "@everyone";
				const men = m.mentions.find((x) => x.id === id);
				if (men?.isMe) return `@${this.cfg.name}`;
				return `@${men?.name ?? this.names.get(id) ?? id.slice(0, 8)}`;
			});
		const images: Image[] = [];
		for (const a of m.attachments) {
			if (a.contentType === "voice") {
				content += a.asr ? ` [voice: ${a.asr}]` : " [voice]";
				continue;
			}
			if (!a.url) continue;
			try {
				const isImg = a.contentType.startsWith("image/");
				const limit = isImg ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
				if (a.size && a.size > limit) {
					content += ` [file ${a.filename} too large, not downloaded]`;
					continue;
				}
				const res = await fetchTrustedMedia(a.url);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const buf = new Uint8Array(await res.arrayBuffer());
				if (buf.byteLength > limit) throw new Error("too large");
				const safe = basename(a.filename).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_") || "file";
				const ext = extname(safe) || (isImg ? `.${a.contentType.split("/")[1] || "png"}` : "");
				const path = join(this.dir, "inbox", `${Date.now()}-${safe.replace(/\.[^.]*$/, "")}${ext}`);
				writeFileSync(path, buf);
				const rel = path.slice(this.dir.length + 1);
				if (isImg) {
					// Lazy: the model opens it with the read tool only when it cares (saves tokens and
					// keeps the persisted session small).
					content += ` [image ${rel}]`;
				} else if (a.contentType.startsWith("video/")) {
					content += ` [video ${rel}]`;
				} else {
					content += ` [file ${rel}]`;
				}
			} catch (e) {
				content += ` [attachment ${a.filename} download failed]`;
				this.log(`attachment download failed: ${(e as Error).message}`);
			}
		}
		const who =
			this.type === "group"
				? `${m.authorName ?? "member"}(${m.authorId.slice(0, 8)}${m.authorRole && m.authorRole !== "member" ? `,${m.authorRole === "owner" ? "owner" : "admin"}` : ""}${m.authorIsBot ? ",bot" : ""})`
				: (m.authorName ?? "friend");
		const flags = `${m.mentionedMe ? " (@me)" : ""}${m.quote ? ` (quote: ${decodeFaces(m.quote).replace(/\s+/g, " ").slice(0, 200)})` : ""}`;
		return { text: `[${time}] #${ref} ${who}${flags}: ${content.trim() || "(empty)"}`, images };
	}

	private async flush(): Promise<void> {
		this.timer = undefined;
		if (!this.pending.lines.length) return;
		if (this.running) {
			// A run is active (or the session is still initialising). Steer only once the agent
			// loop is actually streaming; otherwise leave the batch pending for the post-run drain.
			const s = this.session;
			if (s?.isStreaming) {
				const batch = this.takePending();
				const images = s.model?.input?.includes("image") ? batch.images : [];
				await s.steer(batch.text, images.length ? images : undefined).catch((e) => this.log(`steer failed: ${e}`));
			}
			return;
		}
		// Claim the run BEFORE any await so concurrent flushes can't both call prompt().
		this.running = true;
		try {
			let session: AgentSession;
			try {
				session = await this.ensureSession();
			} catch (e) {
				this.log(`[${this.convId.slice(0, 8)}] session init failed: ${(e as Error).message}`);
				return;
			}
			const canSee = !!session.model?.input?.includes("image");
			let batch = this.takePending();
			while (batch.text) {
				this.sentThisRun = 0;
				try {
					await session.prompt(batch.text, canSee && batch.images.length ? { images: batch.images } : undefined);
				} catch (e) {
					this.log(`[${this.convId.slice(0, 8)}] prompt failed: ${(e as Error).message}`);
				}
				// A steer that landed after the agent loop's last check is still queued; recover it
				// (pi's queue keeps only text, so images of that batch are dropped) plus any new batch.
				const leftover = session.pendingMessageCount ? session.clearQueue() : { steering: [], followUp: [] };
				const next = this.takePending();
				const texts = [...leftover.steering, ...leftover.followUp, next.text].filter(Boolean);
				batch = { text: texts.join("\n"), images: next.images };
			}
		} finally {
			this.running = false;
		}
		if (this.pending.lines.length && !this.timer) void this.flush();
	}

	private takePending(): { text: string; images: Image[] } {
		const b = this.pending;
		this.pending = { lines: [], images: [] };
		return { text: b.lines.join("\n"), images: b.images };
	}

	// ---------- session ----------

	private ensureSession(): Promise<AgentSession> {
		if (this.session) return Promise.resolve(this.session);
		this.initPromise ??= this.createSession().then((s) => {
			this.session = s;
			return s;
		});
		this.initPromise.catch(() => (this.initPromise = undefined));
		return this.initPromise;
	}

	private async createSession(): Promise<AgentSession> {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(this.dir, agentDir);
		const memoPath = join(this.dir, "MEMORY.md");
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.dir,
			agentDir,
			settingsManager,
			appendSystemPrompt: [personaPrompt(this.cfg, this.type)],
			// Never recursively load this bridge inside conversation sessions.
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter((e) => !isSelf(e.path) && !isSelf(e.resolvedPath)),
			}),
			agentsFilesOverride: (base) => {
				const files = base.agentsFiles.filter((f) => resolve(f.path) !== memoPath);
				if (existsSync(memoPath)) files.push({ path: memoPath, content: readFileSync(memoPath, "utf8") });
				return { agentsFiles: files };
			},
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.dir,
			agentDir,
			settingsManager,
			resourceLoader,
			// Persistent per-chat session: resumes the latest one after a restart.
			// Images are not inlined (models read inbox/ on demand), so files stay small.
			sessionManager: SessionManager.continueRecent(this.dir, join(this.dir, ".sessions")),
			customTools: this.tools(),
		});
		await session.bindExtensions({});
		const tag = this.convId.slice(0, 8);
		session.subscribe((ev: any) => {
			if (ev.type === "tool_execution_start" && !String(ev.toolName).startsWith("qq_send")) {
				this.log(`[${tag}] 🔧 ${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 80)}`);
			} else if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const thought = (ev.message.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join(" ")
					.trim();
				if (thought) this.log(`[${tag}] 💭 ${thought.replace(/\s+/g, " ").slice(0, 100)}`);
				if (ev.message.errorMessage) this.log(`[${tag}] ❌ ${ev.message.errorMessage.slice(0, 120)}`);
			}
		});
		await this.applyRuntime(session);
		// Deliver every queued chat batch at once instead of pi's default one-per-turn,
		// so messages that piled up mid-run reach the model together.
		session.setSteeringMode("all");
		session.setFollowUpMode("all");
		this.log(`[${this.convId.slice(0, 8)}] session ready (${session.model?.provider}/${session.model?.id}, thinking ${session.thinkingLevel}) at ${this.dir}`);
		return session;
	}

	/** Host-provided model/thinking (follows the host pi); config values override when set. */
	host: { model?: Model<any>; thinking?: string } = {};

	private async applyRuntime(session: AgentSession): Promise<void> {
		let model = this.host.model;
		if (this.cfg.model) {
			const [provider, ...rest] = this.cfg.model.split("/");
			model = session.modelRuntime.getModel(provider, rest.join("/")) ?? model;
		}
		if (model && (session.model?.provider !== model.provider || session.model?.id !== model.id)) {
			await session.setModel(model);
			this.log(`[${this.convId.slice(0, 8)}] model -> ${model.provider}/${model.id}`);
		}
		const thinking = this.cfg.thinking ?? this.host.thinking;
		// SAFETY: level comes from the host or config; pi clamps unsupported levels to model capabilities.
		if (thinking) session.setThinkingLevel(thinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
		if (thinking && thinking !== this.lastThinking) {
			if (this.lastThinking) this.log(`[${this.convId.slice(0, 8)}] thinking -> ${thinking}`);
			this.lastThinking = thinking;
		}
	}

	/** Called when the host pi switches model or thinking level. */
	async setHost(host: { model?: Model<any>; thinking?: string }): Promise<void> {
		this.host = { ...this.host, ...host };
		if (this.session) await this.applyRuntime(this.session);
	}

	// ---------- outbound ----------

	private nextSeq(): { msgId?: string; seq: number } {
		const a = this.anchor;
		if (a && Date.now() - a.at < PASSIVE_WINDOW_MS) return { msgId: a.id, seq: a.seq++ };
		return { seq: Math.floor(Math.random() * 65535) + 1 };
	}

	async sendText(text: string, replyTo?: number): Promise<boolean> {
		const quoteId = replyTo ? this.refs.get(replyTo) : undefined;
		const { msgId, seq } = this.nextSeq();
		await this.qq.sendText(this.type, this.convId, this.encodeMentions(text), msgId ?? "", seq, quoteId);
		return !!quoteId;
	}

	/**
	 * QQ group bots can't render real @ tags in text messages (both `<qqbot-at-user />`
	 * and `<@openid>` show up literally, tested), so mentions are sent as plain
	 * `@nickname` text. Any raw tag the model copies from history is turned back into a name.
	 */
	encodeMentions(text: string): string {
		const name = (id: string) => this.names.get(id) ?? [...this.names].find(([k]) => k.startsWith(id))?.[1];
		return text
			.replace(/<qqbot-at-user\s+id="([^"]*)"\s*\/?>/g, (_a, id: string) => `@${name(id) ?? ""}`)
			.replace(/<@!?([0-9A-Fa-f]{6,})>/g, (_a, id: string) => `@${name(id) ?? ""}`)
			.replace(/@\[([^\]\n]{1,64})\]/g, (_a, key: string) => `@${name(key) ?? key}`)
			.replace(/@(?=\s|$)/g, "");
	}

	async sendLocal(path: string, kind: "image" | "file" | "video"): Promise<void> {
		const abs = resolve(this.dir, path);
		const data = readFileSync(abs);
		const fileType = kind === "image" ? 1 : kind === "video" ? 2 : 4;
		const info = await this.qq.uploadMedia(this.type, this.convId, fileType, { data: data.toString("base64") });
		const { msgId, seq } = this.nextSeq();
		await this.qq.sendMedia(this.type, this.convId, info, msgId ?? "", seq);
	}

	/** Simulate human typing latency between consecutive messages. */
	private async typingDelay(text: string): Promise<void> {
		if (this.sentThisRun++ === 0) return;
		const ms = Math.min(4000, 400 + text.length * 60) * (0.7 + Math.random() * 0.6);
		await new Promise((r) => setTimeout(r, ms));
	}

	private tools() {
		const conv = this;
		const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
		return [
			defineTool({
				name: "qq_send",
				label: "QQ Send",
				description:
					"Send one text message to the current QQ chat. This is the only way to speak. One short message per call; call repeatedly for several messages.",
				parameters: Type.Object({
					text: Type.String({ description: "Message text to send" }),
					reply_to: Type.Optional(
						Type.Integer({ description: "Quote-reply a message: its #N number from the chat log. Omit for a normal message." }),
					),
				}),
				async execute(_id, params) {
					const text = params.text.trim();
					if (!text) return ok("empty message, not sent");
					await conv.typingDelay(text);
					const quoted = await conv.sendText(text.slice(0, 2000), params.reply_to);
					conv.log(`[${conv.convId.slice(0, 8)}] -> ${conv.cfg.name}${quoted ? ` (re #${params.reply_to})` : ""}: ${text.slice(0, 100)}`);
					return ok(params.reply_to && !quoted ? "sent (quote target unknown, sent as normal message)" : "sent");
				},
			}),
			defineTool({
				name: "qq_send_image",
				label: "QQ Send Image",
				description: "Send a local image (png/jpg/gif) to the current QQ chat. path may be relative to the working directory or absolute.",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_id, params) {
					await conv.sendLocal(params.path, "image");
					return ok("image sent");
				},
			}),
			defineTool({
				name: "qq_find_sticker",
				label: "QQ Find Sticker",
				description:
					"Search the shared sticker library by keywords (emotion, meme, name, emoji). Empty query lists some stickers.",
				parameters: Type.Object({ query: Type.String() }),
				async execute(_id, params) {
					const hits = conv.stickers.search(params.query, 10);
					return ok(hits.length ? conv.stickers.describe(hits) : "no matching sticker");
				},
			}),
			defineTool({
				name: "qq_send_sticker",
				label: "QQ Send Sticker",
				description:
					"Send a sticker from the shared library by name (or keywords; best match is used). Use it like a real person reacting with a meme.",
				parameters: Type.Object({ name: Type.String() }),
				async execute(_id, params) {
					const s = conv.stickers.find(params.name);
					if (!s) return ok("sticker not found; try qq_find_sticker");
					await conv.typingDelay("");
					await conv.sendLocal(conv.stickers.path(s), "image");
					conv.log(`[${conv.convId.slice(0, 8)}] -> ${conv.cfg.name}: [sticker ${s.name}]`);
					return ok(`sent sticker ${s.name}`);
				},
			}),
			defineTool({
				name: "qq_save_sticker",
				label: "QQ Save Sticker",
				description:
					"Save an image (e.g. a meme someone posted, from inbox/) into the shared sticker library so you can reuse it later. Give a short unique name, a description of when to use it, and tags.",
				parameters: Type.Object({
					path: Type.String(),
					name: Type.String(),
					desc: Type.String(),
					tags: Type.Optional(Type.Array(Type.String())),
				}),
				async execute(_id, params) {
					const s = conv.stickers.save(resolve(conv.dir, params.path), {
						name: params.name,
						desc: params.desc,
						tags: params.tags ?? [],
						pack: "collected",
					});
					return ok(`saved as ${s.name}`);
				},
			}),
			defineTool({
				name: "qq_send_file",
				label: "QQ Send File",
				description: "Send a local file to the current QQ chat (group file sending may be restricted by the platform). Use this for mp4 videos too.",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_id, params) {
					const kind = /\.mp4$/i.test(params.path) ? "video" : "file";
					await conv.sendLocal(params.path, kind);
					return ok("file sent");
				},
			}),
		];
	}

	/** Context usage of this chat's session, e.g. "12k/1.0M (1%)". */
	usage(): string | undefined {
		const u = this.session?.getContextUsage();
		if (!u) return undefined;
		const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
		return `${u.tokens == null ? "?" : k(u.tokens)}/${k(u.contextWindow)}${u.percent == null ? "" : ` (${Math.round(u.percent)}%)`}`;
	}

	async dispose(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.session?.dispose();
		this.session = undefined;
	}
}

function isSelf(p?: string): boolean {
	return !!p && /pi-qbot/i.test(p.replaceAll("\\", "/"));
}

/** Only download attachments from QQ's own media CDNs over HTTPS (SSRF guard). */
const TRUSTED_MEDIA_HOSTS = [/\.qq\.com$/, /\.qq\.com\.cn$/, /\.qpic\.cn$/, /\.gtimg\.cn$/, /\.myqcloud\.com$/];
export function isTrustedMediaUrl(raw: string): boolean {
	try {
		const u = new URL(raw);
		const host = `.${u.hostname.toLowerCase()}`;
		return u.protocol === "https:" && TRUSTED_MEDIA_HOSTS.some((re) => re.test(host));
	} catch {
		return false;
	}
}

/** Fetch an attachment only after the URL passes the QQ CDN allowlist; redirects are refused. */
function fetchTrustedMedia(raw: string): Promise<Response> {
	if (!isTrustedMediaUrl(raw)) return Promise.reject(new Error(`untrusted attachment host: ${raw}`));
	const url = new URL(raw).toString();
	return fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
}

/** Turn QQ face/sticker markup like <faceType=6,faceId="0",ext="base64"> into readable text. */
function decodeFaces(text: string): string {
	return text.replace(/<faceType=[^>]*>/g, (raw) => {
		const ext = /ext="([^"]*)"/.exec(raw)?.[1];
		let name = "";
		try {
			name = ext ? String(JSON.parse(Buffer.from(ext, "base64").toString("utf8")).text ?? "") : "";
		} catch {
			/* ignore malformed ext */
		}
		return name ? `[sticker:${name}]` : "[sticker]";
	});
}
