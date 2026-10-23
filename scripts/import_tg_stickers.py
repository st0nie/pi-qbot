#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow==11.3.0", "imageio-ffmpeg==0.6.0", "rlottie-python==1.3.7"]
# ///
"""Import a Telegram sticker set into the pi-qbot sticker library.

Usage: TG_BOT_TOKEN=... ./import_tg_stickers.py <set name or t.me/addstickers/URL> <stickers dir>

Static .webp -> .png, video .webm -> .gif (bundled ffmpeg), animated .tgs -> .gif (rlottie).
Entries are merged into <stickers dir>/index.json.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Third-party deps are declared inline (PEP 723) and installed by `uv run --script`.
import imageio_ffmpeg  # type: ignore[import-not-found]
from PIL import Image  # type: ignore[import-not-found]
from rlottie_python import LottieAnimation  # type: ignore[import-not-found]

API = "https://api.telegram.org"


def _open(url: str, timeout: int):
    """urlopen restricted to HTTPS on api.telegram.org (no file:/custom schemes)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "api.telegram.org":
        raise SystemExit(f"refusing to open non-Telegram URL: {parsed.scheme}://{parsed.hostname}")
    return urllib.request.urlopen(url, timeout=timeout)  # noqa: S310 - scheme/host validated above


def _fetch(url: str, timeout: int, attempts: int = 5) -> bytes:
    """GET with retries; the local proxy occasionally drops TLS handshakes."""
    for i in range(attempts):
        try:
            with _open(url, timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if i == attempts - 1:
                raise SystemExit(f"request failed after {attempts} attempts: {e}") from e
            time.sleep(1.5 * (i + 1))
    raise AssertionError("unreachable")


def api(token: str, method: str, **params: str) -> dict:
    url = f"{API}/bot{token}/{method}?" + urllib.parse.urlencode(params)
    try:
        body = json.loads(_fetch(url, 30))
    except json.JSONDecodeError as e:
        raise SystemExit(f"Telegram request {method} returned invalid JSON: {e}") from e
    if not body.get("ok"):
        raise SystemExit(f"Telegram API error: {body.get('description')}")
    return body["result"]


def download(token: str, file_id: str) -> bytes:
    path = api(token, "getFile", file_id=file_id)["file_path"]
    return _fetch(f"{API}/file/bot{token}/{urllib.parse.quote(path)}", 60)


def load_index(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"cannot read {path}: {e}") from e


def convert(st: dict, src: Path, out: Path, base: str, ffmpeg: str) -> Path:
    if st.get("is_video"):
        dst = out / f"{base}.gif"
        vf = "fps=15,scale=240:-1:flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse"
        cmd = [ffmpeg, "-y", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", str(src), "-vf", vf, str(dst)]
        subprocess.run(cmd, check=True)  # noqa: S603 - argv list, no shell; paths are our temp files
    elif st.get("is_animated"):
        dst = out / f"{base}.gif"
        LottieAnimation.from_tgs(str(src)).save_animation(str(dst), width=240, height=240)
    else:
        dst = out / f"{base}.png"
        img = Image.open(src).convert("RGBA")
        img.thumbnail((320, 320))
        img.save(dst)
    return dst


def main() -> None:
    token = os.environ.get("TG_BOT_TOKEN")
    if not token or len(sys.argv) < 3:
        raise SystemExit(__doc__)
    name = re.sub(r"^.*addstickers/", "", sys.argv[1]).strip("/")
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    index_path = out / "index.json"
    index = load_index(index_path)
    known = {e["file"] for e in index}
    sset = api(token, "getStickerSet", name=name)
    title = sset.get("title", name)
    print(f"{title}: {len(sset['stickers'])} stickers")
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    workers = int(os.environ.get("TG_WORKERS", "8"))

    def one(i: int, st: dict) -> tuple[int, dict, Path | None]:
        base = f"{name}_{i:03d}"
        # Resume: skip stickers already converted by a previous run.
        for ext in (".png", ".gif"):
            done = out / f"{base}{ext}"
            if done.exists() and done.stat().st_size > 0:
                return i, st, done
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "src"
            try:
                src.write_bytes(download(token, st["file_id"]))
                return i, st, convert(st, src, out, base, ffmpeg)
            except (SystemExit, subprocess.CalledProcessError, OSError, ValueError) as e:
                print(f"  skip {base}: {e}", flush=True)
                return i, st, None

    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, i, st) for i, st in enumerate(sset["stickers"], 1)]
        for n, fut in enumerate(as_completed(futures), 1):
            i, st, dst = fut.result()
            results.append((i, st, dst))
            if dst:
                print(f"  [{n}/{len(futures)}] {dst.name} {st.get('emoji', '')}", flush=True)
    failed = 0
    for _i, st, dst in sorted(results, key=lambda r: r[0]):
        if dst is None:
            failed += 1
            continue
        if dst.name not in known:
            index.append(
                {"file": dst.name, "name": dst.stem, "emoji": st.get("emoji", ""),
                 "tags": [], "desc": "", "pack": title}
            )
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"done -> {index_path} ({len(results) - failed} ok, {failed} failed; rerun to retry failures)")


if __name__ == "__main__":
    main()
