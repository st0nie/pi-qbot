import { afterEach, describe, expect, test } from "bun:test";
import { QQClient, QQGateway, type InboundMessage } from "../src/qq.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function json(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("QQClient", () => {
	test("retries safe GETs on 500 and honors retry-after", async () => {
		let tokenCalls = 0;
		let gatewayCalls = 0;
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url.includes("getAppAccessToken")) {
				tokenCalls++;
				return json({ access_token: "token", expires_in: 7200 });
			}
			gatewayCalls++;
			if (gatewayCalls === 1) return json({ message: "temporary" }, { status: 500, headers: { "retry-after": "0" } });
			return json({ url: "wss://gateway.example" });
		};
		const client = new QQClient("id", "secret");
		expect(await client.request("GET", "/gateway")).toEqual({ url: "wss://gateway.example" });
		expect(tokenCalls).toBe(1);
		expect(gatewayCalls).toBe(2);
	});

	test("does not retry a message POST after a network failure", async () => {
		let apiCalls = 0;
		globalThis.fetch = async (input) => {
			if (String(input).includes("getAppAccessToken")) return json({ access_token: "token", expires_in: 7200 });
			apiCalls++;
			throw new Error("socket lost after send");
		};
		const client = new QQClient("id", "secret");
		await expect(client.sendText("group", "g", "hello", "m1", 1)).rejects.toThrow("socket lost after send");
		expect(apiCalls).toBe(1);
	});

	test("refreshes an expired token once on 401", async () => {
		let tokenCalls = 0;
		let apiCalls = 0;
		const auths: string[] = [];
		globalThis.fetch = async (input, init) => {
			if (String(input).includes("getAppAccessToken")) {
				tokenCalls++;
				return json({ access_token: `token-${tokenCalls}`, expires_in: 7200 });
			}
			apiCalls++;
			auths.push(String((init?.headers as Record<string, string>).Authorization));
			if (apiCalls === 1) return json({ message: "expired" }, { status: 401 });
			return json({ url: "wss://gateway.example" });
		};
		const client = new QQClient("id", "secret");
		await client.request("GET", "/gateway");
		expect(tokenCalls).toBe(2);
		expect(apiCalls).toBe(2);
		expect(auths).toEqual(["QQBot token-1", "QQBot token-2"]);
	});

	test("media sends caption and message_reference without blank content", async () => {
		let payload: any;
		globalThis.fetch = async (input, init) => {
			if (String(input).includes("getAppAccessToken")) return json({ access_token: "token", expires_in: 7200 });
			payload = JSON.parse(String(init?.body));
			return json({ id: "sent-media" });
		};
		const client = new QQClient("id", "secret");
		await client.sendMedia("group", "g", "file-info", "m1", 2, "caption", "quoted-id");
		expect(payload.content).toBe("caption");
		expect(payload.message_reference).toEqual({ message_id: "quoted-id", ignore_get_message_error: true });
		await client.sendMedia("group", "g", "file-info", "m1", 3);
		expect(payload.content).toBeUndefined();
		expect(payload.message_reference).toBeUndefined();
	});
});

describe("QQGateway dispatch", () => {
	test("maps group/C2C messages, mentions, attachments and quote metadata", async () => {
		const messages: InboundMessage[] = [];
		const gateway = new QQGateway({} as QQClient, (m) => messages.push(m), () => {});
		(gateway as any).dispatch("READY", { session_id: "session" });
		expect(gateway.state).toBe("connected");
		(gateway as any).dispatch("GROUP_AT_MESSAGE_CREATE", {
			id: "m1",
			group_openid: "group-openid",
			author: { member_openid: "member-openid", username: "Alice", member_role: "admin" },
			mentions: [{ member_openid: "bot-id", username: "Rana", is_you: true }],
			content: "<@!bot-id> hello",
			attachments: [{ content_type: "image/png", filename: "a.png", url: "//gchat.qpic.cn/a", size: 3 }],
			message_type: 103,
			msg_elements: [{ id: "quoted-id", content: "old text", author: { username: "Bob" } }],
			timestamp: "2026-01-01T00:00:00Z",
		});
		(gateway as any).dispatch("C2C_MESSAGE_CREATE", {
			id: "m2",
			author: { user_openid: "user-openid", username: "Alice" },
			content: "private",
		});
		(gateway as any).dispatch("MESSAGE_CREATE", { id: "ignored" });
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			id: "m1",
			type: "group",
			convId: "group-openid",
			authorId: "member-openid",
			authorRole: "admin",
			mentionedMe: true,
			quoteMsgId: "quoted-id",
			quote: "Bob: old text",
		});
		expect(messages[0].attachments[0].url).toBe("https://gchat.qpic.cn/a");
		expect(messages[0].mentions[0]).toEqual({ id: "bot-id", name: "Rana", isMe: true });
		expect(messages[1]).toMatchObject({ id: "m2", type: "c2c", convId: "user-openid", authorId: "user-openid" });

		(gateway as any).sessionId = "session";
		(gateway as any).seq = 10;
		(gateway as any).ws = { close: () => {} };
		await (gateway as any).handle(JSON.stringify({ op: 9, d: false }));
		expect((gateway as any).sessionId).toBeUndefined();
		expect((gateway as any).seq).toBeNull();
		gateway.stop();
	});
});
