import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

/** One sticker in the shared library (<root>/stickers/index.json). */
export interface Sticker {
	file: string;
	name: string;
	emoji?: string;
	tags?: string[];
	desc?: string;
	pack?: string;
}

const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Shared sticker library: imported packs plus stickers collected from chats. */
export class StickerLibrary {
	readonly dir: string;
	private readonly indexPath: string;

	constructor(root: string) {
		this.dir = resolve(root, "stickers");
		this.indexPath = join(this.dir, "index.json");
		mkdirSync(this.dir, { recursive: true });
	}

	list(): Sticker[] {
		if (!existsSync(this.indexPath)) return [];
		try {
			const data = JSON.parse(readFileSync(this.indexPath, "utf8"));
			return Array.isArray(data) ? data : [];
		} catch {
			return [];
		}
	}

	private write(items: Sticker[]): void {
		writeFileSync(this.indexPath, JSON.stringify(items, null, 1));
	}

	/** Rank stickers by keyword overlap with name, emoji, tags, desc and pack. */
	search(query: string, limit = 8): Sticker[] {
		const terms = query
			.toLowerCase()
			.split(/[\s,，]+/)
			.filter(Boolean);
		const scored = this.list().map((s) => {
			const hay = [s.name, s.emoji, s.desc, s.pack, ...(s.tags ?? [])].join(" ").toLowerCase();
			const score = terms.reduce((n, t) => n + (hay.includes(t) ? (s.name.toLowerCase() === t ? 5 : 1) : 0), 0);
			return { s, score };
		});
		return scored
			.filter((x) => x.score > 0 || !terms.length)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((x) => x.s);
	}

	/** Resolve a sticker by exact name, else best search hit. */
	find(query: string): Sticker | undefined {
		const items = this.list();
		return items.find((s) => s.name === query || s.file === query) ?? this.search(query, 1)[0];
	}

	path(s: Sticker): string {
		const p = resolve(this.dir, basename(s.file));
		if (!p.startsWith(this.dir)) throw new Error("bad sticker path");
		return p;
	}

	/** Copy an image into the library and index it (overwrites an entry with the same name). */
	save(srcPath: string, meta: Omit<Sticker, "file">): Sticker {
		const ext = extname(srcPath).toLowerCase();
		if (!ALLOWED_EXT.has(ext)) throw new Error(`unsupported sticker type ${ext}`);
		const safe = meta.name.replace(/[^\w\-\u4e00-\u9fa5]/g, "_").slice(0, 60) || `sticker_${Date.now()}`;
		const file = `${safe}${ext}`;
		copyFileSync(srcPath, join(this.dir, file));
		const items = this.list().filter((s) => s.name !== meta.name);
		const entry: Sticker = { ...meta, name: safe, file };
		items.push(entry);
		this.write(items);
		return entry;
	}

	/** Compact one-line-per-sticker summary for the model. */
	describe(items: Sticker[]): string {
		return items
			.map((s) => `${s.name} ${s.emoji ?? ""} ${s.desc ? `- ${s.desc}` : ""} ${s.tags?.length ? `[${s.tags.join(", ")}]` : ""}`.trim())
			.join("\n");
	}
}
