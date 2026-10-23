# pi-qbot

A [pi](https://github.com/earendil-works/pi) extension that puts a pi agent into QQ group chats through the **official QQ Bot API** (`api.sgroup.qq.com`). Each group gets its own working directory and its own persistent pi session. The agent behaves like an ordinary group member rather than an assistant.

## Features

- **One directory and one session per chat.** Groups map to `groups/<group_openid>/` and private chats to `users/<user_openid>/`. Each has a `MEMORY.md`, an `inbox/` and a `.sessions/` folder, and the session resumes after a restart.
- **Full pi.** Each per-chat session loads pi's built-in tools plus your installed extensions and skills. pi-qbot itself is never loaded into them.
- **Human-like chat.**
  - The model's plain text is never sent. It speaks only through `qq_send`, so it can choose to stay silent.
  - Incoming messages are debounced into batches, and messages arriving mid-run are steered into the current turn.
  - Replies have typing-delay pacing, and the system prompt is written as a persona.
- **Full-message mode.** The bot reads both `GROUP_AT_MESSAGE_CREATE` and `GROUP_MESSAGE_CREATE`, so it sees every message once the group owner enables "receive all messages".
- **Media.**
  - Received images and files are saved to `inbox/`. The model opens them with `read` only when it cares.
  - The bot can send images and files.
  - Voice messages arrive with QQ's ASR text, and quoted messages are decoded.
- **Quote replies.** Each transcript line carries a `#N` number. `qq_send` accepts `reply_to: N`, which is sent as a `message_reference`.
- **Stickers.** A library in `stickers/` is shared by all chats. The tools `qq_find_sticker`, `qq_send_sticker` and `qq_save_sticker` let the bot collect memes from chats, and `scripts/import_tg_stickers.py` imports Telegram sticker packs.
- **Follows the host.** Chat sessions use the host pi's model and thinking level, and live `/model` or thinking switches propagate to every chat.

## Requirements

- pi ≥ 1.4 and Node ≥ 22.19 (or Bun)
- A QQ bot from [q.qq.com](https://q.qq.com) with its **AppID** and **AppSecret**. The bot must have the group / C2C message intents.
- Optional: the group owner enables the bot's "接收全部消息" (receive all messages) switch in the group's bot settings. Without it the bot only sees messages that @ it.

## Quick start

```bash
git clone https://github.com/st0nie/pi-qbot
mkdir ~/qqbot-root && cd ~/qqbot-root
cat > qqbot.json <<'EOF'
{
  "appId": "YOUR_APP_ID",
  "secret": "YOUR_APP_SECRET",
  "name": "小Q"
}
EOF
chmod 600 qqbot.json
pi -e ~/path/to/pi-qbot/src/index.ts --qqbot --model <provider/model> --thinking low
```

The bridge only starts with `--qqbot` (or `/qqbot start` later). Without the flag, the extension stays inert.

### Commands

| Command | Description |
|---|---|
| `/qqbot status` | Gateway state, each chat's directory and its context usage |
| `/qqbot logs` | Last 30 log lines |
| `/qqbot start` / `/qqbot stop` | Start or stop the bridge in the current pi |

A live feed widget above the editor shows incoming lines, replies, tool calls and silent "thoughts". The status bar shows the gateway state and per-chat context usage.

## Configuration (`qqbot.json`)

| Key | Default | Description |
|---|---|---|
| `appId`, `secret` | – | Bot credentials. Can also come from `QQBOT_APP_ID` / `QQBOT_SECRET` |
| `sandbox` | `false` | Use the sandbox API. Can also come from `QQBOT_SANDBOX=1` |
| `root` | cwd | Root for `groups/`, `users/` and `stickers/` |
| `name` | `QBot` | Name the bot goes by in chat |
| `persona` | `""` | Extra persona text appended to the system prompt |
| `allowPrivate` | `true` | Answer C2C private chats |
| `groups` | `[]` | Allowlist of group openids. Empty means all groups |
| `debounceMs` | `1500` | Quiet window before a batch is sent to the model. @-mentions and private chats use 600 ms |
| `model`, `thinking` | host | Pin the chat sessions to a model or thinking level instead of following the host |

The file can also live at `.pi/qqbot.json`.

## Layout of the bot root

```text
qqbot.json
stickers/            shared sticker library (index.json + images)
groups/<openid>/
  MEMORY.md          long-term notes, injected into the session context
  inbox/             received images / files
  .sessions/         persistent pi session
users/<openid>/      same, for private chats
```

## Stickers

Import a Telegram pack. You need a bot token from [@BotFather](https://t.me/BotFather):

```bash
TG_BOT_TOKEN=... uv run --script scripts/import_tg_stickers.py \
  https://t.me/addstickers/<pack> ~/qqbot-root/stickers
```

The importer converts static stickers to png, and video and animated stickers to gif. It downloads in parallel (`TG_WORKERS`, default 8), resumes interrupted runs and merges into `index.json`. To make search work, add a `desc` and `tags` to each entry.

## Docker

`Dockerfile` builds pi plus pi-qbot, together with the CLIProxyAPI provider, realmem, empty-text-guard, magic-context, web tools, todo and background-tasks extensions. Adjust the `pi install` lines to taste. `deploy/docker-compose.yml` runs it:

```text
<deploy dir>/
  docker-compose.yml
  src/                 this repo
  data/                bot root (qqbot.json, groups/, stickers/)
  pi-agent/            cliproxyapi.json, auth.json, models.json, trust.json, realmem/, rpiv-web-tools/
  cortexkit/           magic-context config + data
```

```bash
docker compose up -d --build
docker exec -it pi-qbot tmux attach -t qqbot   # watch / drive; Ctrl-b d to detach
```

The extension source and the entrypoint are bind-mounted, so code changes only need `docker compose up -d --force-recreate`. Build args `HTTP(S)_PROXY` in the compose file route the build through a proxy. They are build-time only.

## Platform limitations (QQ official bots)

- **No real @ in groups.** Both `<qqbot-at-user id="…" />` (the documented format) and `<@openid>` render as literal text in group chats. The bot writes `@nickname` as plain text instead.
- **QQ adds an automatic @.** When the bot replies to a message that @-mentioned it, QQ itself prepends or appends `@sender`, for text and media alike.
- **No native QQ faces.** QQ faces can't be sent in groups. The bot uses Unicode emoji or image stickers.
- **Passive replies only.** A passive reply must anchor to a received message within 5 minutes. Proactive group messages are limited to 4 per month.
- **URLs need allowlisting.** Messages containing URLs need the domain allowlisted in the q.qq.com console.

## Security

Every group member can drive a full pi agent, including bash, file access and the network. Run the bot in a container or under a dedicated user, keep secrets out of its reach, and consider restricting tools.

Attachment downloads are limited to HTTPS QQ CDN hosts, and redirects are refused.

Never commit `qqbot.json`.

## Development

```bash
bun install
bunx tsc --noEmit
```

## License

MIT
