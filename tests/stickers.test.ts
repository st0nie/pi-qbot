import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StickerLibrary } from "../src/stickers.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-qbot-stickers-"));
	roots.push(root);
	const source = join(root, "source.png");
	writeFileSync(source, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
	return { root, source, library: new StickerLibrary(root) };
}

describe("StickerLibrary", () => {
	test("ranks exact names/tags and falls back to Chinese bigrams", () => {
		const { source, library } = setup();
		library.save(source, { name: "美滋滋", desc: "得意洋洋，适合阴阳怪气", tags: ["得意", "黄脸"], pack: "collected" });
		library.save(source, { name: "开心小鸡", desc: "开心地跳舞", tags: ["开心", "跳舞"], pack: "collected" });
		library.save(source, { name: "零伤害", desc: "嘲讽零输出", tags: ["LOL"], pack: "collected" });
		expect(library.search("美滋滋")[0].name).toBe("美滋滋");
		expect(library.search("开心")[0].name).toBe("开心小鸡");
		expect(library.search("这也太得意了吧")[0].name).toBe("美滋滋");
		expect(library.find("美滋滋.PNG")).toBeDefined();
		expect(library.search("不存在")).toEqual([]);
	});

	test("reloads cache after another chat updates the shared index and writes atomically", () => {
		const { root, source, library } = setup();
		library.save(source, { name: "旧表情", desc: "old", tags: [] });
		expect(library.list()).toHaveLength(1);
		const otherChat = new StickerLibrary(root);
		otherChat.save(source, { name: "新表情", desc: "new", tags: ["新"] });
		expect(library.list()).toHaveLength(2);
		expect(library.find("新表情")?.desc).toBe("new");
		expect(readdirSync(library.dir).some((f) => f.includes(".tmp"))).toBe(false);

		library.save(source, { name: "新 表情", desc: "replacement", tags: ["新", "新", " "] });
		expect(library.list().filter((s) => s.name === "新_表情")).toHaveLength(1);
		expect(library.list().filter((s) => s.name === "新表情")).toHaveLength(1);
		expect(library.find("新_表情")?.tags).toEqual(["新"]);
	});
});
