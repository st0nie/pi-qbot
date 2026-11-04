import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Conversation, decodeFaces, isTrustedMediaUrl, sniffMedia } from "../src/conversation.ts";
import { personaPrompt } from "../src/prompt.ts";
import type { BotConfig } from "../src/config.ts";
import type { InboundMessage, QQClient } from "../src/qq.ts";

const roots: string[] = [];
const conversations: Conversation[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
	globalThis.fetch = originalFetch;
	await Promise.all(conversations.splice(0).map((c) => c.dispose()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): BotConfig {
	const root = mkdtempSync(join(tmpdir(), "pi-qbot-test-"));
	roots.push(root);
	return {
		appId: "test",
		secret: "test",
		sandbox: true,
		root,
		name: "Rana",
		persona: "稳定、自然、有一点毒舌。",
		allowPrivate: true,
		groups: [],
		debounceMs: 5,
	};
}

class FakeQQ {
	text: any[][] = [];
	media: any[][] = [];
	uploads: any[][] = [];
	recalls: any[][] = [];
	async sendText(...args: any[]) {
		this.text.push(args);
		return { id: `sent-${this.text.length}` };
	}
	async uploadMedia(...args: any[]) {
		this.uploads.push(args);
		return `file-info-${this.uploads.length}`;
	}
	async sendMedia(...args: any[]) {
		this.media.push(args);
		return { id: `media-${this.media.length}` };
	}
	async recall(...args: any[]) {
		this.recalls.push(args);
		return {};
	}
}

function setup(type: "group" | "c2c" = "group", convId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", cfg = config()) {
	const qq = new FakeQQ();
	const conv = new Conversation(type, convId, cfg, qq as unknown as QQClient, () => {});
	conversations.push(conv);
	return { cfg, qq, conv };
}

function inbound(id: string, convId: string, text: string, attachments: InboundMessage["attachments"] = []): InboundMessage {
	return {
		id,
		type: "group",
		convId,
		authorId: "ABCDEF1234567890",
		authorName: "Alice",
		authorIsBot: false,
		mentionedMe: false,
		mentions: [],
		text,
		attachments,
		timestamp: new Date().toISOString(),
	};
}

function fakeSession(prompts: string[]) {
	return {
		model: { input: [] },
		isStreaming: false,
		pendingMessageCount: 0,
		prompt: async (text: string) => {
			prompts.push(text);
		},
		clearQueue: () => ({ steering: [], followUp: [] }),
		dispose: () => {},
	};
}

describe("shared identity with chat-local routing", () => {
	test("two groups share cwd/persona but keep independent transcripts and #N refs", async () => {
		const a = setup("group", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		const b = setup("group", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", a.cfg);
		expect(a.conv.cwd).toBe(b.conv.cwd);
		expect(a.conv.dir).not.toBe(b.conv.dir);
		expect(a.conv.stickers.dir).toBe(b.conv.stickers.dir);

		const aPrompts: string[] = [];
		const bPrompts: string[] = [];
		(a.conv as any).session = fakeSession(aPrompts);
		(b.conv as any).session = fakeSession(bPrompts);
		await Promise.all([a.conv.push(inbound("a1", a.conv.convId, "from A")), b.conv.push(inbound("b1", b.conv.convId, "from B"))]);
		await Promise.all([(a.conv as any).flush(), (b.conv as any).flush()]);
		expect(aPrompts[0]).toContain(`[chat group:${a.conv.tag}]`);
		expect(aPrompts[0]).toContain("#1 Alice");
		expect(aPrompts[0]).toContain("from A");
		expect(aPrompts[0]).not.toContain("from B");
		expect(bPrompts[0]).toContain(`[chat group:${b.conv.tag}]`);
		expect(bPrompts[0]).toContain("#1 Alice");
		expect(bPrompts[0]).toContain("from B");

		const prompt = personaPrompt(a.cfg, "group", a.conv.tag, "共享人格", relative(a.conv.cwd, a.conv.dir));
		expect(prompt).toContain("SAME person");
		expect(prompt).toContain(a.conv.tag);
		expect(prompt).toContain("共享人格");
		expect(prompt).not.toContain("Update MEMORY.md");
	});

	test("quote, mention, sent ids and refs survive restart per chat", async () => {
		const { conv, qq, cfg } = setup();
		await conv.push(inbound("m1", conv.convId, "hello"));
		const first = await conv.sendText("hi", 1, "#1");
		expect(first.quoted).toBe(true);
		expect(first.sid).toBe(1);
		expect(qq.text[0][2]).toBe("@Alice hi");
		expect(qq.text[0][5]).toBe("m1");
		await conv.dispose();

		const restored = new Conversation("group", conv.convId, cfg, qq as unknown as QQClient, () => {});
		conversations.push(restored);
		const second = await restored.sendText("after restart", 1);
		expect(second.sid).toBe(2);
		expect(qq.text[1][5]).toBe("m1");
		expect(restored.resolveName("#1")).toBe("Alice");
		expect(await restored.recall(1)).toBe("recalled s1");
		expect(qq.recalls).toHaveLength(1);
	});

	test("image upload supports chat-relative path, caption, @ and quote", async () => {
		const { conv, qq } = setup();
		await conv.push(inbound("m1", conv.convId, "look"));
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		writeFileSync(join(conv.dir, "inbox", "pic.png"), png);
		const result = await conv.sendLocal("inbox/pic.png", "image", { replyTo: 1, caption: "look", at: "#1" });
		expect(result).toEqual({ sid: 1, quoted: true });
		expect(qq.uploads[0][2]).toBe(1);
		expect(Buffer.from(qq.uploads[0][3].data, "base64")).toEqual(Buffer.from(png));
		expect(qq.media[0][5]).toBe("@Alice look");
		expect(qq.media[0][6]).toBe("m1");
	});
});

describe("attachment hardening", () => {
	test("detects GIF magic for unnamed attachments and stores a root-relative image path", async () => {
		const { conv } = setup();
		const gif = Uint8Array.from([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0]);
		globalThis.fetch = async () => new Response(gif, { status: 200 });
		await conv.push(
			inbound("m1", conv.convId, "", [
				{ contentType: "application/octet-stream", filename: "未命名", url: "https://multimedia.nt.qq.com.cn/download?x=1" },
			]),
		);
		const line = (conv as any).pending.lines.join("\n");
		expect(line).toContain(`[chat group:${conv.tag}]`);
		expect(line).toContain("[image groups/");
		expect(line).toContain(".gif]");
		expect(readdirSync(join(conv.dir, "inbox")).some((f) => f.endsWith(".gif"))).toBe(true);
	});

	test("rejects oversized bodies before reading them and restricts attachment hosts", async () => {
		const { conv } = setup();
		globalThis.fetch = async () => new Response("tiny", { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } });
		await conv.push(
			inbound("m1", conv.convId, "", [
				{ contentType: "image/png", filename: "fake.png", url: "https://multimedia.nt.qq.com.cn/fake" },
			]),
		);
		expect((conv as any).pending.lines.join("\n")).toContain("download failed");
		expect(isTrustedMediaUrl("https://multimedia.nt.qq.com.cn/a")).toBe(true);
		expect(isTrustedMediaUrl("http://multimedia.nt.qq.com.cn/a")).toBe(false);
		expect(isTrustedMediaUrl("https://evilqq.com/a")).toBe(false);
		expect(isTrustedMediaUrl("https://qq.com.evil.test/a")).toBe(false);
	});

	test("sniffs common media and decodes QQ face markup", () => {
		expect(sniffMedia(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))?.mime).toBe("image/png");
		expect(sniffMedia(Uint8Array.from([0xff, 0xd8, 0xff, 0]))?.mime).toBe("image/jpeg");
		expect(sniffMedia(Buffer.from("GIF87a........"))?.mime).toBe("image/gif");
		expect(sniffMedia(Buffer.from("RIFF....WEBP...."))?.mime).toBe("image/webp");
		expect(sniffMedia(Buffer.from("....ftypisom...."))?.mime).toBe("video/mp4");
		expect(sniffMedia(Buffer.from("OggS...."))?.mime).toBe("audio/ogg");
		expect(sniffMedia(Buffer.from("plain"))).toBeUndefined();
		const ext = Buffer.from(JSON.stringify({ text: "[点赞]" })).toString("base64");
		expect(decodeFaces(`<faceType=6,faceId="0",ext="${ext}">`)).toBe("[sticker:点赞]");
	});
});
