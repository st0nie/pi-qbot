/**
 * Minimal official QQ Bot (api.sgroup.qq.com) client: auth, REST and gateway.
 * Docs: https://bot.q.qq.com/wiki/develop/api-v2/
 */

const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

export type ConvType = "group" | "c2c";

export interface Attachment {
	contentType: string;
	filename: string;
	url?: string;
	size?: number;
	/** Voice ASR text provided by QQ */
	asr?: string;
}

export interface InboundMessage {
	id: string;
	type: ConvType;
	/** group_openid for groups, user_openid for c2c */
	convId: string;
	authorId: string;
	authorName?: string;
	authorRole?: string;
	authorIsBot: boolean;
	/** Bot was @-mentioned */
	mentionedMe: boolean;
	mentions: { id: string; name?: string; isMe: boolean }[];
	text: string;
	attachments: Attachment[];
	/** Text of a quoted/referenced message, if any */
	quote?: string;
	timestamp: string;
}

export class QQClient {
	private token?: string;
	private expiresAt = 0;
	private inflight?: Promise<string>;
	readonly base: string;

	constructor(
		private readonly appId: string,
		private readonly secret: string,
		sandbox = false,
	) {
		this.base = sandbox ? SANDBOX_BASE : API_BASE;
	}

	async getToken(): Promise<string> {
		if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
		this.inflight ??= (async () => {
			try {
				const res = await fetch(TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
				});
				const body = (await res.json()) as { access_token?: string; expires_in?: string | number; message?: string };
				if (!body.access_token) throw new Error(`QQ auth failed (${res.status}) ${body.message ?? ""}`);
				this.token = body.access_token;
				this.expiresAt = Date.now() + (Number(body.expires_in) || 7200) * 1000;
				return this.token;
			} finally {
				this.inflight = undefined;
			}
		})();
		return this.inflight;
	}

	async request(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
		const res = await fetch(this.base + path, {
			method,
			headers: { "Content-Type": "application/json", Authorization: `QQBot ${await this.getToken()}` },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let json: Record<string, unknown> = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			/* non-JSON body */
		}
		if (!res.ok) {
			throw new Error(`QQ ${method} ${path} -> ${res.status} code=${json.code ?? "?"} ${json.message ?? text.slice(0, 200)}`);
		}
		return json;
	}

	private prefix(type: ConvType, convId: string): string {
		return type === "group" ? `/v2/groups/${encodeURIComponent(convId)}` : `/v2/users/${encodeURIComponent(convId)}`;
	}

	/** Passive text reply (msg_id + unique msg_seq). */
	/** Text message; `quoteId` renders as a quote-reply of that message (message_reference). */
	sendText(type: ConvType, convId: string, content: string, msgId: string, msgSeq: number, quoteId?: string) {
		return this.request("POST", `${this.prefix(type, convId)}/messages`, {
			content,
			msg_type: 0,
			msg_id: msgId,
			msg_seq: msgSeq,
			...(quoteId ? { message_reference: { message_id: quoteId, ignore_get_message_error: true } } : {}),
		});
	}

	/** Upload media (1 image, 2 video, 3 voice/silk, 4 file) without sending it. */
	async uploadMedia(type: ConvType, convId: string, fileType: 1 | 2 | 3 | 4, src: { url?: string; data?: string }) {
		const body = await this.request(
			"POST",
			`${this.prefix(type, convId)}/files`,
			{
				file_type: fileType,
				srv_send_msg: false,
				...(src.url ? { url: src.url } : { file_data: src.data }),
			},
			60_000,
		);
		if (typeof body.file_info !== "string") throw new Error("upload response missing file_info");
		return body.file_info;
	}

	sendMedia(type: ConvType, convId: string, fileInfo: string, msgId: string, msgSeq: number, caption = "") {
		return this.request("POST", `${this.prefix(type, convId)}/messages`, {
			// Omit content when there is no caption; a placeholder renders as an extra blank line.
			// (QQ itself prefixes "@sender" when replying to an @-message; content can't prevent it.)
			...(caption.trim() ? { content: caption } : {}),
			msg_type: 7,
			media: { file_info: fileInfo },
			msg_id: msgId,
			msg_seq: msgSeq,
		});
	}
}

const INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT

export class QQGateway {
	private ws?: WebSocket;
	private heartbeat?: ReturnType<typeof setInterval>;
	private seq: number | null = null;
	private sessionId?: string;
	private backoff = 1000;
	private stopped = false;
	state = "idle";

	constructor(
		private readonly client: QQClient,
		private readonly onMessage: (m: InboundMessage) => void,
		private readonly log: (s: string) => void,
	) {}

	start(): void {
		this.stopped = false;
		void this.open();
	}

	stop(): void {
		this.stopped = true;
		if (this.heartbeat) clearInterval(this.heartbeat);
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = undefined;
		this.state = "stopped";
	}

	private async open(): Promise<void> {
		if (this.stopped) return;
		this.state = "connecting";
		let url: string;
		try {
			url = String((await this.client.request("GET", "/gateway")).url);
		} catch (e) {
			this.log(`gateway lookup failed: ${(e as Error).message}`);
			return this.retry();
		}
		const ws = new WebSocket(url);
		this.ws = ws;
		ws.onmessage = (ev) => this.handle(String(ev.data));
		ws.onclose = (ev) => {
			if (this.ws !== ws) return;
			if (this.heartbeat) clearInterval(this.heartbeat);
			this.state = `closed(${ev.code})`;
			this.log(`gateway closed ${ev.code} ${ev.reason ?? ""}`);
			// 4004 invalid token, 4006/4007/4009 session invalid -> fresh identify
			if ([4006, 4007, 4009, 4900, 4901, 4902, 4903, 4904, 4905, 4906, 4907, 4908, 4909, 4910, 4911, 4912, 4913].includes(ev.code)) {
				this.sessionId = undefined;
				this.seq = null;
			}
			this.retry();
		};
		ws.onerror = () => this.log("gateway socket error");
	}

	private retry(): void {
		if (this.stopped) return;
		const d = this.backoff;
		this.backoff = Math.min(this.backoff * 2, 60_000);
		setTimeout(() => void this.open(), d);
	}

	private send(p: unknown): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(p));
	}

	private async handle(raw: string): Promise<void> {
		let p: { op: number; d?: any; s?: number; t?: string };
		try {
			p = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof p.s === "number") this.seq = p.s;
		switch (p.op) {
			case 10: {
				if (this.heartbeat) clearInterval(this.heartbeat);
				this.heartbeat = setInterval(() => this.send({ op: 1, d: this.seq }), p.d?.heartbeat_interval ?? 41_250);
				const token = `QQBot ${await this.client.getToken()}`;
				if (this.sessionId && this.seq != null) {
					this.send({ op: 6, d: { token, session_id: this.sessionId, seq: this.seq } });
				} else {
					this.send({ op: 2, d: { token, intents: INTENTS, shard: [0, 1], properties: {} } });
				}
				break;
			}
			case 7: // server asks reconnect
				this.ws?.close();
				break;
			case 9: // invalid session
				this.sessionId = undefined;
				this.seq = null;
				this.ws?.close();
				break;
			case 0:
				this.dispatch(p.t ?? "", p.d);
				break;
		}
	}

	private dispatch(t: string, d: any): void {
		if (t === "READY" || t === "RESUMED") {
			if (d?.session_id) this.sessionId = d.session_id;
			this.backoff = 1000;
			this.state = "connected";
			this.log(`gateway ${t}`);
			return;
		}
		const isGroup = t === "GROUP_AT_MESSAGE_CREATE" || t === "GROUP_MESSAGE_CREATE";
		if (!isGroup && t !== "C2C_MESSAGE_CREATE") return;
		if (!d?.id) return;
		const convId = isGroup ? d.group_openid : d.author?.user_openid;
		if (!convId) return;
		const mapAtt = (list: any): Attachment[] =>
			Array.isArray(list)
				? list.map((a: any, i: number) => ({
						contentType: String(a.content_type ?? ""),
						filename: String(a.filename ?? `attachment-${i + 1}`),
						url: typeof a.url === "string" ? (a.url.startsWith("//") ? `https:${a.url}` : a.url) : undefined,
						size: typeof a.size === "number" ? a.size : undefined,
						asr: typeof a.asr_refer_text === "string" ? a.asr_refer_text : undefined,
					}))
				: [];
		const mentions: any[] = Array.isArray(d.mentions) ? d.mentions : [];
		// Quoted / forwarded content (message_type 103 = reference)
		let quote: string | undefined;
		const el = Array.isArray(d.msg_elements) ? d.msg_elements[0] : undefined;
		if (el && (d.message_type === 103 || el.content)) {
			const who = el.author?.username ? `${el.author.username}: ` : "";
			quote = `${who}${String(el.content ?? "").trim()}`.slice(0, 500);
		}
		this.onMessage({
			id: d.id,
			type: isGroup ? "group" : "c2c",
			convId,
			authorId: isGroup ? (d.author?.member_openid ?? "") : convId,
			authorName: d.author?.username || undefined,
			authorRole: d.author?.member_role || undefined,
			authorIsBot: !!d.author?.bot,
			mentionedMe: t === "GROUP_AT_MESSAGE_CREATE" || mentions.some((m) => m?.is_you),
			mentions: mentions
				.filter((m) => m?.member_openid || m?.id)
				.map((m) => ({ id: String(m.member_openid ?? m.id), name: m.nickname ?? m.username, isMe: !!m.is_you })),
			text: typeof d.content === "string" ? d.content.trim() : "",
			attachments: [...mapAtt(d.attachments), ...(el ? mapAtt(el.attachments) : [])],
			quote,
			timestamp: d.timestamp ?? new Date().toISOString(),
		});
	}
}
