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

const BUILTIN_SKILLS_DIR = resolve(import.meta.dirname, "../skills");
const BUILTIN_SKILL_NAMES = ["qq-quote-reply", "qq-mention"];
export function builtinSkillPaths(): string[] {
	return BUILTIN_SKILL_NAMES.map((name) => join(BUILTIN_SKILLS_DIR, name)).filter((p) => existsSync(p));
}

export interface RefEntry {
	id: string;
	at: number;
	seq: number;
	authorId: string;
	authorName?: string;
	mentionedMe: boolean;
	text: string;
}

/** One QQ group / private chat = one directory = one persistent pi session. */
export class Conversation {
	readonly dir: string;
	private session?: AgentSession;
	private initPromise?: Promise<AgentSession>;
	private pending: { lines: string[]; images: Image[] } = { lines: [], images: [] };
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	/** Latest inbound msg used as default passive-reply anchor */
	private anchor?: RefEntry;
	private names = new Map<string, string>();
	/** Short transcript refs (#N) -> inbound message metadata, for quote replies and @ resolution. */
	private refs = new Map<number, RefEntry>();
	private refSeq = 0;
	/** Messages the bot sent: s-number -> QQ message id + send time, for recall. */
	private sent = new Map<number, { id: string; at: number; preview: string }>();
	private sentSeq = 0;
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
		if (m.authorName) this.names.set(m.authorId, m.authorName);
		for (const men of m.mentions) if (men.name && !men.isMe) this.names.set(men.id, men.name);
		const ref = ++this.refSeq;
		const entry: RefEntry = {
			id: m.id,
			at: Date.now(),
			seq: 1,
			authorId: m.authorId,
			authorName: m.authorName,
			mentionedMe: m.mentionedMe,
			text: m.text,
		};
		this.anchor = entry;
		this.refs.set(ref, entry);
		if (this.refs.size > 500) this.refs.delete(this.refs.keys().next().value!);
		const line = await this.format(m, ref);
		this.pending.lines.push(line.text);
		this.log(`[${this.convId.slice(0, 8)}] ${line.text.slice(0, 140)}`);
		this.pending.images.push(...line.images);
		// Answer faster when directly addressed or quoted; otherwise wait a bit to batch chatter.
		const delay = m.mentionedMe || line.quotedMe || this.type === "c2c" ? 600 : this.cfg.debounceMs;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), delay);
	}

	private async format(m: InboundMessage, ref: number): Promise<{ text: string; images: Image[]; quotedMe: boolean }> {
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
		let quoteText = m.quote;
		let quotedMe = false;
		let quotedRef: number | undefined;
		if (m.quoteMsgId) {
			const sentHit = [...this.sent.values()].find((s) => s.id === m.quoteMsgId);
			if (sentHit) {
				quotedMe = true;
				quoteText ??= `${this.cfg.name}: ${sentHit.preview}`;
			} else {
				const refHit = [...this.refs.entries()].find(([k, v]) => k !== ref && v.id === m.quoteMsgId);
				if (refHit) {
					quotedRef = refHit[0];
					const r = refHit[1];
					quoteText ??= `${r.authorName ?? this.names.get(r.authorId) ?? "member"}: ${r.text}`;
				}
			}
		}
		if (!quotedMe && quoteText && this.cfg.name && quoteText.startsWith(`${this.cfg.name}:`)) {
			quotedMe = true;
		}
		const who =
			this.type === "group"
				? `${m.authorName ?? "member"}(${m.authorId.slice(0, 8)}${m.authorRole && m.authorRole !== "member" ? `,${m.authorRole === "owner" ? "owner" : "admin"}` : ""}${m.authorIsBot ? ",bot" : ""})`
				: (m.authorName ?? "friend");
		const quoteLabel = quotedMe ? "quote @me" : quotedRef ? `quote #${quotedRef}` : "quote";
		const flags = `${m.mentionedMe ? " (@me)" : ""}${quoteText ? ` (${quoteLabel}: ${decodeFaces(quoteText).replace(/\s+/g, " ").slice(0, 200)})` : ""}`;
		return { text: `[${time}] #${ref} ${who}${flags}: ${content.trim() || "(empty)"}`, images, quotedMe };
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
			additionalSkillPaths: builtinSkillPaths(),
			appendSystemPrompt: [personaPrompt(this.cfg, this.type)],
			// Never recursively load this bridge inside conversation sessions.
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter((e) => !isSelf(e.path) && !isSelf(e.resolvedPath)),
			}),
			skillsOverride: (base) => ({
				skills: base.skills.filter((s) => s.name !== "run-workflow"),
				diagnostics: base.diagnostics,
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

	private nextSeq(target?: RefEntry): { msgId?: string; seq: number } {
		const now = Date.now();
		if (target && now - target.at < PASSIVE_WINDOW_MS) return { msgId: target.id, seq: target.seq++ };
		const a = this.anchor;
		if (a && now - a.at < PASSIVE_WINDOW_MS) return { msgId: a.id, seq: a.seq++ };
		return { seq: Math.floor(Math.random() * 65535) + 1 };
	}

	async sendText(text: string, replyTo?: number, at?: string | string[]): Promise<{ quoted: boolean; sid?: number; text: string }> {
		const target = replyTo ? this.refs.get(replyTo) : undefined;
		const quoteId = target?.id;
		const finalText = this.applyAtMentions(text, at);
		const { msgId, seq } = this.nextSeq(target);
		const res = await this.qq.sendText(this.type, this.convId, finalText, msgId ?? "", seq, quoteId);
		const sid = this.remember(res, finalText);
		return { quoted: !!quoteId, sid, text: finalText };
	}

	/** Remember a sent message id so it can be recalled; returns its s-number. */
	private remember(res: Record<string, unknown>, preview: string): number | undefined {
		if (typeof res.id !== "string") return undefined;
		const n = ++this.sentSeq;
		this.sent.set(n, { id: res.id, at: Date.now(), preview: preview.slice(0, 40) });
		if (this.sent.size > 50) this.sent.delete(this.sent.keys().next().value!);
		return n;
	}

	async recall(n?: number): Promise<string> {
		const key = n ?? this.sentSeq;
		const m = this.sent.get(key);
		if (!m) return `no sent message s${key}`;
		if (Date.now() - m.at > 2 * 60 * 1000) return `s${key} is older than 2 minutes; QQ no longer allows recalling it`;
		await this.qq.recall(this.type, this.convId, m.id);
		this.sent.delete(key);
		this.log(`[${this.convId.slice(0, 8)}] recalled s${key}: ${m.preview}`);
		return `recalled s${key}`;
	}

	/** Resolve a nickname, @nickname, nickname(id), #N message ref, or hex id prefix to a clean display name. */
	resolveName(raw: string): string {
		const trimmed = raw.trim().replace(/^@+/, "").trim();
		if (!trimmed) return "";
		const refMatch = /^#(\d+)$/.exec(trimmed);
		if (refMatch) {
			const ref = this.refs.get(Number(refMatch[1]));
			if (ref) return ref.authorName ?? this.names.get(ref.authorId) ?? ref.authorId.slice(0, 8);
		}
		const stripped = trimmed.replace(/\([0-9a-fA-F]{6,}(?:,[a-z]+)*\)$/, "").trim();
		const byId =
			this.names.get(stripped) ??
			(/^[0-9a-fA-F]{6,}$/.test(stripped)
				? [...this.names].find(([k]) => k.toLowerCase().startsWith(stripped.toLowerCase()))?.[1]
				: undefined);
		return byId ?? stripped;
	}

	/**
	 * QQ group bots can't render real @ tags in text messages (both `<qqbot-at-user />`
	 * and `<@openid>` show up literally, tested), so mentions are sent as plain
	 * `@nickname` text. Any raw tag, #N ref, or internal id suffix the model copies is turned into `@nickname`.
	 */
	encodeMentions(text: string): string {
		const name = (id: string) =>
			this.names.get(id) ?? [...this.names].find(([k]) => k.toLowerCase().startsWith(id.toLowerCase()))?.[1];
		return text
			.replace(/<qqbot-at-user\s+id="([^"]*)"\s*\/?>/g, (_a, id: string) => `@${name(id) ?? ""}`)
			.replace(/<@!?([0-9A-Fa-f]{6,})>/g, (_a, id: string) => `@${name(id) ?? ""}`)
			.replace(/@\[([^\]\n]{1,64})\]/g, (_a, key: string) => `@${this.resolveName(key)}`)
			.replace(/@#(\d+)\b/g, (all, num: string) => {
				const r = this.refs.get(Number(num));
				const n = r ? (r.authorName ?? name(r.authorId)) : undefined;
				return n ? `@${n}` : all;
			})
			.replace(/@([^\s@()]{1,64})\([0-9a-fA-F]{6,}(?:,[a-z]+)*\)/g, (_a, nick: string) => `@${nick}`)
			.replace(/@([0-9A-Fa-f]{8,32})\b/g, (all, hex: string) => {
				const n = name(hex);
				return n ? `@${n}` : all;
			})
			.replace(/@(?=\s|$)/g, "");
	}

	/** Prepend @nickname mentions requested via the `at` parameter without duplicating mentions already in text. */
	applyAtMentions(text: string, at?: string | string[]): string {
		const encoded = this.encodeMentions(text);
		if (!at || this.type === "c2c") return encoded;
		const list = (Array.isArray(at) ? at : [at]).map((x) => this.resolveName(x)).filter(Boolean);
		const missing = [...new Set(list)].filter((n) => !encoded.includes(`@${n}`));
		if (!missing.length) return encoded;
		return `${missing.map((n) => `@${n}`).join(" ")} ${encoded}`.trim();
	}

	async sendLocal(path: string, kind: "image" | "file" | "video"): Promise<number | undefined> {
		const abs = resolve(this.dir, path);
		const data = readFileSync(abs);
		const fileType = kind === "image" ? 1 : kind === "video" ? 2 : 4;
		const info = await this.qq.uploadMedia(this.type, this.convId, fileType, { data: data.toString("base64") });
		const { msgId, seq } = this.nextSeq();
		const res = await this.qq.sendMedia(this.type, this.convId, info, msgId ?? "", seq);
		return this.remember(res, `[${kind} ${basename(path)}]`);
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
					at: Type.Optional(
						Type.Union([
							Type.String({ description: "Nickname or #N message ref of a member to @-mention in a group chat." }),
							Type.Array(Type.String(), { description: "Nicknames or #N message refs of members to @-mention in a group chat." }),
						]),
					),
				}),
				async execute(_id, params) {
					const raw = params.text.trim();
					if (!raw) return ok("empty message, not sent");
					await conv.typingDelay(raw);
					const { quoted, sid, text } = await conv.sendText(raw.slice(0, 2000), params.reply_to, params.at);
					conv.log(`[${conv.convId.slice(0, 8)}] -> ${conv.cfg.name}${quoted ? ` (re #${params.reply_to})` : ""}: ${text.slice(0, 100)}`);
					const tag = sid ? ` as s${sid}` : "";
					return ok(params.reply_to && !quoted ? `sent${tag} (quote target unknown, sent as normal message)` : `sent${tag}`);
				},
			}),
			defineTool({
				name: "qq_send_image",
				label: "QQ Send Image",
				description: "Send a local image (png/jpg/gif) to the current QQ chat. path may be relative to the working directory or absolute.",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_id, params) {
					const sid = await conv.sendLocal(params.path, "image");
					return ok(`image sent${sid ? ` as s${sid}` : ""}`);
				},
			}),
			defineTool({
				name: "qq_recall",
				label: "QQ Recall",
				description:
					"Recall (unsend) a message you sent, like a person deleting a typo or a regretted message. Use the s-number from the send result; omit to recall your latest message. Only works within 2 minutes.",
				parameters: Type.Object({ sent: Type.Optional(Type.Integer({ description: "s-number of your sent message" })) }),
				async execute(_id, params) {
					return ok(await conv.recall(params.sent));
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
					const sid = await conv.sendLocal(conv.stickers.path(s), "image");
					conv.log(`[${conv.convId.slice(0, 8)}] -> ${conv.cfg.name}: [sticker ${s.name}]`);
					return ok(`sent sticker ${s.name}${sid ? ` as s${sid}` : ""}`);
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
					const sid = await conv.sendLocal(params.path, kind);
					return ok(`file sent${sid ? ` as s${sid}` : ""}`);
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
export function decodeFaces(text: string): string {
	return text.replace(/<faceType=[^>]*>/g, (raw) => {
		const ext = /ext="([^"]*)"/.exec(raw)?.[1];
		let name = "";
		try {
			name = ext ? String(JSON.parse(Buffer.from(ext, "base64").toString("utf8")).text ?? "") : "";
		} catch {
			/* ignore malformed ext */
		}
		name = name.replace(/^\[+|\]+$/g, "").trim();
		return name ? `[sticker:${name}]` : "[sticker]";
	});
}
