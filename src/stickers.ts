import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	private cache: { stamp: string; items: Sticker[] } = { stamp: "", items: [] };

	constructor(root: string) {
		this.dir = resolve(root, "stickers");
		this.indexPath = join(this.dir, "index.json");
		mkdirSync(this.dir, { recursive: true });
	}

	/** Cached across calls, but reloaded when another chat/import updates index.json. */
	list(): Sticker[] {
		if (!existsSync(this.indexPath)) {
			this.cache = { stamp: "", items: [] };
			return this.cache.items;
		}
		try {
			const stamp = this.stamp();
			if (stamp === this.cache.stamp) return this.cache.items;
			const data = JSON.parse(readFileSync(this.indexPath, "utf8"));
			const items = Array.isArray(data) ? data.filter((s): s is Sticker => !!s && typeof s.name === "string" && typeof s.file === "string") : [];
			this.cache = { stamp, items };
			return items;
		} catch {
			return this.cache.items;
		}
	}

	private stamp(): string {
		const s = statSync(this.indexPath, { bigint: true });
		return `${s.mtimeNs}:${s.size}`;
	}

	private write(items: Sticker[]): void {
		const tmp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(items, null, 1));
			renameSync(tmp, this.indexPath);
			this.cache = { stamp: this.stamp(), items };
		} finally {
			if (existsSync(tmp)) rmSync(tmp, { force: true });
		}
	}

	/** Rank stickers by field-aware keyword overlap; Chinese queries also get bigram fallback. */
	search(query: string, limit = 8): Sticker[] {
		const normalized = query.trim().toLowerCase();
		const terms = normalized.split(/[\s,，、]+/).filter(Boolean);
		const cjkFallback = terms.length === 1 && /^[\p{Script=Han}]{4,}$/u.test(terms[0]) ? bigrams(terms[0]) : [];
		const scored = this.list().map((s, order) => {
			const name = s.name.toLowerCase();
			const tags = (s.tags ?? []).map((t) => t.toLowerCase());
			const desc = s.desc?.toLowerCase() ?? "";
			const pack = s.pack?.toLowerCase() ?? "";
			const emoji = s.emoji?.toLowerCase() ?? "";
			let score = 0;
			for (const term of terms) {
				if (name === term) score += 100;
				else if (name.includes(term)) score += 40;
				if (emoji === term) score += 30;
				if (tags.some((t) => t === term)) score += 25;
				else if (tags.some((t) => t.includes(term))) score += 12;
				if (desc.includes(term)) score += 6;
				if (pack.includes(term)) score += 4;
			}
			// Long unsegmented Chinese queries often contain a useful two-character tag.
			if (!score) for (const term of cjkFallback) {
				if (name.includes(term)) score += 3;
				else if (tags.some((t) => t.includes(term))) score += 2;
				else if (desc.includes(term)) score += 1;
			}
			return { s, score, order };
		});
		return scored
			.filter((x) => x.score > 0 || !terms.length)
			.sort((a, b) => b.score - a.score || a.order - b.order)
			.slice(0, Math.max(0, limit))
			.map((x) => x.s);
	}

	/** Resolve a sticker by exact name/file (case-insensitive), else best search hit. */
	find(query: string): Sticker | undefined {
		const q = query.trim().toLowerCase();
		const items = this.list();
		return items.find((s) => s.name.toLowerCase() === q || s.file.toLowerCase() === q) ?? this.search(query, 1)[0];
	}

	path(s: Sticker): string {
		return join(this.dir, basename(s.file));
	}

	/** Copy an image into the library and index it (overwrites an entry with the same name). */
	save(srcPath: string, meta: Omit<Sticker, "file">): Sticker {
		const ext = extname(srcPath).toLowerCase();
		if (!ALLOWED_EXT.has(ext)) throw new Error(`unsupported sticker type ${ext}`);
		const safe = meta.name.replace(/[^\w\-\u4e00-\u9fa5]/g, "_").slice(0, 60) || `sticker_${Date.now()}`;
		const file = `${safe}${ext}`;
		const dest = join(this.dir, file);
		const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
		try {
			copyFileSync(srcPath, tmp);
			renameSync(tmp, dest);
		} finally {
			if (existsSync(tmp)) rmSync(tmp, { force: true });
		}
		const items = this.list().filter((s) => s.name !== meta.name && s.name !== safe);
		const entry: Sticker = {
			...meta,
			name: safe,
			file,
			tags: [...new Set((meta.tags ?? []).map((t) => t.trim()).filter(Boolean))],
		};
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

function bigrams(s: string): string[] {
	return [...new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)))];
}
