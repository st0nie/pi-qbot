# pi-qbot

A [pi](https://github.com/earendil-works/pi) extension that puts a pi agent into QQ group and private chats through the **official QQ Bot API** (`api.sgroup.qq.com`). All chats share one bot workspace, persona and long-term memory, while each chat keeps an independent session, message history, quote namespace and attachment directory.

## Features

- **One bot, many chats.** `name`, `persona`, optional `PERSONA.md`, skills and the realctx project are shared across every group/C2C chat. The bot does not grow a different personality in each group.
- **Chat-local routing and state.** Groups map to `groups/<group_openid>/` and private chats to `users/<user_openid>/`. Each has its own `inbox/`, `.sessions/` and `.state.json` (message `#N` refs, sent `sN` ids and nicknames). Transcripts and these mappings resume after a restart, and every incoming line is tagged with its chat.
- **Full pi.** Chat sessions load pi's built-in tools plus installed extensions and skills. pi-qbot itself is never recursively loaded into them.
- **Human-like chat.** Plain model text is never sent; the model speaks through QQ tools or stays silent. Incoming messages are batched, mid-run messages are steered into the active turn, and consecutive replies have typing-delay pacing.
- **Full-message mode.** The bot reads both `GROUP_AT_MESSAGE_CREATE` and `GROUP_MESSAGE_CREATE`, so it sees every message once the group owner enables "receive all messages". Duplicate gateway deliveries are filtered by message id.
- **Reliable gateway.** Token refresh, safe GET retries, connection timeout, heartbeat-ack monitoring and bounded reconnect backoff are built in. Message POSTs are not blindly retried after network failures, avoiding duplicate replies.
- **Media.** Attachments are downloaded only from trusted HTTPS QQ CDNs with streaming size limits. PNG/JPEG/GIF/WebP, MP4/MOV/WebM and common audio are identified by magic bytes, so unnamed files still get the right type/extension. Images, stickers, videos and files can be sent with captions.
- **Quote replies & `@` mentions.** Every incoming line has a chat-local `#N`. `qq_send`, `qq_send_image`, `qq_send_sticker` and `qq_send_file` accept `reply_to: N`; media tools also accept `caption`, and text/captions support `at` (`"nickname"`, `"#N"`, or an array). Bundled `qq-quote-reply` and `qq-mention` skills teach the model the platform behavior.
- **Stickers.** `stickers/` is shared by all chats. `qq_find_sticker`, `qq_send_sticker` and `qq_save_sticker` support collecting and reusing memes. The index is cached with cross-chat invalidation, searched with field-aware/CJK scoring, and updated atomically. `scripts/import_tg_stickers.py` imports Telegram packs.
- **Follows the host.** Chat sessions use the host pi's model and thinking level; live `/model` or thinking switches propagate to every chat.

## Requirements

- pi ≥ 1.4 and Node ≥ 22.19 (or Bun)
- A QQ bot from [q.qq.com](https://q.qq.com) with its **AppID** and **AppSecret**, and the group/C2C message intents
- Optional: the group owner enables the bot's "接收全部消息" switch. Without it the bot only sees messages that @ it

## Quick start

```bash
git clone https://github.com/st0nie/pi-qbot
mkdir ~/qqbot-root && cd ~/qqbot-root
cat > qqbot.json <<'EOF'
{
  "appId": "YOUR_APP_ID",
  "secret": "YOUR_APP_SECRET",
  "name": "小Q",
  "persona": "说话自然、简洁，有一点幽默。"
}
EOF
chmod 600 qqbot.json
pi -e ~/path/to/pi-qbot/src/index.ts --qqbot --model <provider/model> --thinking low
```

The bridge only starts with `--qqbot` (or `/qqbot start` later). Without the flag, the extension stays inert.

### Commands

| Command | Description |
|---|---|
| `/qqbot status` (or `chats`) | Bot name, gateway state, shared workspace, each chat's directory and context usage |
| `/qqbot logs [N]` | Last N log lines (default 30, maximum 100) |
| `/qqbot start` / `/qqbot stop` | Start or stop the bridge in the current pi |
| `/qqbot restart` | Restart the gateway and all chat sessions; reloads config, `PERSONA.md` and skills |

A live feed widget shows incoming lines, replies, tool calls and silent model text. The status bar labels context usage by chat tag, so multiple groups remain distinguishable.

## Configuration (`qqbot.json`)

| Key | Default | Description |
|---|---|---|
| `appId`, `secret` | – | Bot credentials. Can also come from `QQBOT_APP_ID` / `QQBOT_SECRET` |
| `sandbox` | `false` | Use the sandbox API. Can also come from `QQBOT_SANDBOX=1` |
| `root` | cwd | Shared bot workspace plus `groups/`, `users/` and `stickers/` |
| `name` | `QBot` | Name the bot goes by in every chat |
| `persona` | `""` | Shared persona text appended to every chat's system prompt |
| `allowPrivate` | `true` | Answer C2C private chats |
| `groups` | `[]` | Allowlist of group openids. Empty means all groups |
| `debounceMs` | `1500` | Quiet window before a batch is sent to the model. @-mentions, quotes and private chats use 600 ms |
| `model`, `thinking` | host | Pin chat sessions to a model/thinking level instead of following the host |

The file can also live at `.pi/qqbot.json`.

### Shared persona and memory

- Put longer owner-controlled personality text in **`<root>/PERSONA.md`**. It is injected into every chat session. Use `/qqbot restart` after editing it.
- Durable memories are managed by **realctx** in the shared bot project, not by per-group `MEMORY.md` files. Group-specific memories are tagged with the current chat and path scope; bot-wide identity/preferences are shared.
- Conversation context is **not** shared between groups. Each session sees only its own transcript. The prompt explicitly forbids leaking one group's messages, jokes, files or private facts into another.

## Layout of the bot root

```text
qqbot.json             credentials + shared configuration
PERSONA.md             optional shared long-form persona
stickers/              shared sticker library (index.json + images)
groups/<openid>/
  inbox/               received images / videos / audio / files
  .sessions/           this group's persistent pi transcript
  .state.json          this group's #N refs, sent ids and nicknames
users/<openid>/        same chat-local layout for private chats
```

## Stickers

Import a Telegram pack (token from [@BotFather](https://t.me/BotFather)):

```bash
TG_BOT_TOKEN=... uv run --script scripts/import_tg_stickers.py \
  https://t.me/addstickers/<pack> ~/qqbot-root/stickers
```

The importer converts static stickers to png, and video/animated stickers to gif. It downloads in parallel (`TG_WORKERS`, default 8), resumes interrupted runs and merges into `index.json`. Useful `desc` and `tags` fields improve search.

## Docker

`Dockerfile` installs pi, pi-qbot, CLIProxyAPI, realctx, realtasks, web tools and todo, plus Python/Pillow and ffmpeg for media work. It enables **codemode by default for every session** with this setting in `/root/.pi/agent/settings.json`:

```json
{ "defaultTools": ["+codemode"] }
```

This retains the normal tools and adds codemode, letting agents batch tool calls and use classifier/image models through scripts. For a non-Docker installation, use the same setting or run `pi --tools +codemode`.

`deploy/docker-compose.yml` runs the image:

```text
<deploy dir>/
  docker-compose.yml
  src/                 this repo
  data/                shared bot root (qqbot.json, PERSONA.md, groups/, stickers/)
  pi-agent/            provider auth/model/trust config, realctx/, rpiv-web-tools/
```

```bash
docker compose up -d --build
docker exec -it pi-qbot tmux attach -t qqbot   # watch / drive; Ctrl-b d to detach
```

The extension source, bundled skills and entrypoint are bind-mounted. Source/skill-only updates can use `docker compose restart`; Dockerfile/settings changes require `docker compose up -d --build`. Compose `HTTP(S)_PROXY` build args are build-time only.

## Platform limitations (QQ official bots)

- **No real @ in groups.** Both `<qqbot-at-user id="…" />` and `<@openid>` render as literal text. The bot writes `@nickname` as plain text instead.
- **QQ adds an automatic @.** When replying to a message that @-mentioned it, QQ may prepend/append `@sender`, for text and media alike.
- **No native QQ faces or poke events.** QQ faces cannot be sent in groups (use Unicode emoji/image stickers), and double-click avatar pokes ("拍一拍" / "戳一戳") are not pushed to official bots.
- **Passive replies only.** A passive reply must anchor to a received message within 5 minutes. Proactive group messages are limited to 4 per month.
- **URLs need allowlisting.** Message URLs need their domain allowlisted in the q.qq.com console.

## Security

Every group member can potentially drive a full pi agent, including bash, file access and the network. Run the bot in a container or under a dedicated user, keep secrets out of reach, and restrict tools where appropriate.

The shared workspace is **not a security boundary**: although the prompt isolates chat context and forbids cross-group access, an agent with shell/file tools can technically reach other chat directories. Only put groups that trust each other on one deployment; use separate containers/roots for hard isolation.

Attachment downloads are limited to HTTPS QQ CDN hosts; redirects are refused and bodies are size-limited while streaming. Never commit `qqbot.json` or provider credentials.

## Development

```bash
bun install
bun run check        # tsc --noEmit + focused Bun tests
```

Tests cover shared-vs-chat-local state, multi-group attribution, quote/mention/media behavior, state restoration, attachment sniffing/limits, QQ auth/retry/gateway mapping, and sticker cache/search. Run them separately with `bun test`.

## License

MIT
