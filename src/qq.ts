/**
 * Minimal official QQ Bot (api.sgroup.qq.com) client: auth, REST and gateway.
 * Docs: https://bot.q.qq.com/wiki/develop/api-v2/
 */

const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const delay = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
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
	/** Message ID of the quoted/referenced message, if any */
	quoteMsgId?: string;
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
					signal: AbortSignal.timeout(15_000),
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

	invalidateToken(): void {
		this.token = undefined;
		this.expiresAt = 0;
	}

	async request(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
		// Reads are safe to retry. Message POSTs are deliberately not retried after a
		// network failure: the server may have accepted them, and retrying could double-send.
		const attempts = method === "GET" ? 3 : 1;
		let refreshed = false;
		for (let attempt = 0; ; attempt++) {
			try {
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
				if (res.status === 401 && !refreshed) {
					refreshed = true;
					this.invalidateToken();
					continue;
				}
				if (!res.ok) {
					if (attempt + 1 < attempts && (res.status === 429 || res.status >= 500)) {
						const retryAfter = res.headers.get("retry-after");
						const retryMs = retryAfter == null ? NaN : Number(retryAfter) * 1000;
						await delay(Number.isFinite(retryMs) ? Math.min(10_000, Math.max(0, retryMs)) : 300 * 2 ** attempt);
						continue;
					}
					throw new Error(`QQ ${method} ${path} -> ${res.status} code=${json.code ?? "?"} ${json.message ?? text.slice(0, 200)}`);
				}
				return json;
			} catch (e) {
				if (attempt + 1 < attempts && !(e instanceof Error && e.message.startsWith("QQ "))) {
					await delay(300 * 2 ** attempt);
					continue;
				}
				throw e;
			}
		}
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

	/** Recall (delete) a message the bot sent. QQ only allows this within ~2 minutes. */
	recall(type: ConvType, convId: string, messageId: string) {
		return this.request("DELETE", `${this.prefix(type, convId)}/messages/${encodeURIComponent(messageId)}`);
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

	sendMedia(type: ConvType, convId: string, fileInfo: string, msgId: string, msgSeq: number, caption = "", quoteId?: string) {
		return this.request("POST", `${this.prefix(type, convId)}/messages`, {
			// Omit content when there is no caption; a placeholder renders as an extra blank line.
			// (QQ itself prefixes "@sender" when replying to an @-message; content can't prevent it.)
			...(caption.trim() ? { content: caption } : {}),
			msg_type: 7,
			media: { file_info: fileInfo },
			msg_id: msgId,
			msg_seq: msgSeq,
			...(quoteId ? { message_reference: { message_id: quoteId, ignore_get_message_error: true } } : {}),
		});
	}
}

const INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT

export class QQGateway {
	private ws?: WebSocket;
	private heartbeat?: ReturnType<typeof setInterval>;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private connectTimer?: ReturnType<typeof setTimeout>;
	private seq: number | null = null;
	private sessionId?: string;
	private backoff = 1000;
	private stopped = false;
	private opening = false;
	private awaitingAck = false;
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
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.heartbeat = undefined;
		this.retryTimer = undefined;
		this.connectTimer = undefined;
		const ws = this.ws;
		this.ws = undefined;
		if (ws) {
			ws.onclose = null;
			ws.onerror = null;
			ws.onmessage = null;
			ws.onopen = null;
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
		this.state = "stopped";
	}

	private async open(): Promise<void> {
		if (this.stopped || this.opening) return;
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
		this.opening = true;
		this.state = "connecting";
		try {
			const url = String((await this.client.request("GET", "/gateway")).url);
			if (this.stopped || !url || url === "undefined") throw new Error("gateway response missing url");
			const ws = new WebSocket(url);
			this.ws = ws;
			this.connectTimer = setTimeout(() => {
				this.log("gateway connect timed out");
				ws.close();
			}, 20_000);
			ws.onopen = () => {
				if (this.connectTimer) clearTimeout(this.connectTimer);
			};
			ws.onmessage = (ev) => {
				void this.handle(String(ev.data)).catch((e) => {
					this.log(`gateway packet failed: ${(e as Error).message}`);
					ws.close();
				});
			};
			ws.onclose = (ev) => {
				if (this.ws !== ws) return;
				if (this.heartbeat) clearInterval(this.heartbeat);
				if (this.connectTimer) clearTimeout(this.connectTimer);
				this.ws = undefined;
				this.awaitingAck = false;
				this.log(`gateway closed ${ev.code} ${ev.reason ?? ""}`);
				// Invalid sessions cannot be resumed. Auth failures also need a fresh token.
				if ([4004, 4006, 4007, 4009, ...Array.from({ length: 14 }, (_, i) => 4900 + i)].includes(ev.code)) {
					this.sessionId = undefined;
					this.seq = null;
				}
				if (ev.code === 4004) this.client.invalidateToken();
				this.retry();
			};
			ws.onerror = () => this.log("gateway socket error");
		} catch (e) {
			this.log(`gateway lookup failed: ${(e as Error).message}`);
			this.retry();
		} finally {
			this.opening = false;
		}
	}

	private retry(): void {
		if (this.stopped || this.retryTimer) return;
		const d = this.backoff;
		this.backoff = Math.min(this.backoff * 2, 60_000);
		this.state = `retry in ${Math.ceil(d / 1000)}s`;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.open();
		}, d);
	}

	private send(p: unknown): boolean {
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify(p));
		return true;
	}

	private async handle(raw: string): Promise<void> {
		let p: { op: number; d?: any; s?: number; t?: string };
		try {
			p = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof p.s === "number") this.seq = p.s;
		if (p.op === 0 || p.op === 11) this.awaitingAck = false;
		switch (p.op) {
			case 10: {
				if (this.heartbeat) clearInterval(this.heartbeat);
				this.heartbeat = setInterval(() => {
					if (this.awaitingAck) {
						this.log("gateway heartbeat ack timeout");
						this.ws?.close();
						return;
					}
					if (this.send({ op: 1, d: this.seq })) this.awaitingAck = true;
				}, p.d?.heartbeat_interval ?? 41_250);
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
			case 9: // invalid session; d=true means resume is still allowed
				if (p.d !== true) {
					this.sessionId = undefined;
					this.seq = null;
				}
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
		// Quoted / forwarded content (message_type 103 = reference, or message_reference)
		let quote: string | undefined;
		const el = Array.isArray(d.msg_elements) ? d.msg_elements[0] : undefined;
		if (el && (d.message_type === 103 || el.content)) {
			const who = el.author?.username ? `${el.author.username}: ` : "";
			quote = `${who}${String(el.content ?? "").trim()}`.slice(0, 500);
		}
		const refId = d.message_reference?.message_id ?? el?.id ?? el?.message_id;
		const quoteMsgId = typeof refId === "string" && refId ? refId : undefined;
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
			quoteMsgId,
			timestamp: d.timestamp ?? new Date().toISOString(),
		});
	}
}
