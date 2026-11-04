---
name: qq-quote-reply
description: Use when replying to a specific QQ message with reply_to in qq_send, qq_send_image, qq_send_sticker, or qq_send_file, reading incoming quote annotations, or handling interleaved multi-person conversations.
---

# Quoting Messages in QQ Chat (`reply_to`)

Every incoming line starts with `[chat group:TAG]` (or `c2c`) to identify its chat, followed by time and a chat-local `#N` reference number. The examples below omit chat/time prefixes for readability:

```text
[21:03:10] #14 阿明(a1b2c3d4): 周末有人去爬山吗？
[21:03:15] #15 小红(e5f6a7b8): 我今晚先肝完作业
[21:03:18] #16 老王(99887766) (@me): @小Q 你觉得周六天气怎么样
```

## How to Send a Quote-Reply

Pass the integer `N` (without `#`) as `reply_to` in `qq_send`, `qq_send_image`, `qq_send_sticker`, or `qq_send_file`. Media tools also accept an optional `caption`:

```json
{
  "text": "周六看预报是大晴天，挺适合出门的",
  "reply_to": 16
}
```

For an image/sticker/file, use the same #N and optionally add a caption:

```json
{
  "path": "groups/<chat>/inbox/photo.jpg",
  "caption": "就是这张图",
  "reply_to": 16
}
```

`#N` mappings are restored after a bot restart, but they are always local to the current chat. Never use a number seen in another group.

When `reply_to` is provided:
- QQ renders your message with a visual quote bubble pointing to message `#16`.
- If message `#16` was received within the last 4.5 minutes, the bot also anchors the passive reply directly to `#16`.

## When to Use `reply_to` (and When Not To)

Real chat members use quote-replies selectively to avoid confusion, not on every single line:

1. **Use `reply_to` when:**
   - **Other messages intervened:** Someone asked or said something earlier (`#14`), other people talked afterward (`#15`, `#16`), and you are answering `#14`.
   - **Busy multi-topic chat:** Two or more conversations are happening at once and it would be unclear which message you are responding to.
   - **Calling out a specific line:** You want to tease, Agree/disagree with, or point at one specific statement or image someone posted earlier.
   - **Replying to a slow task:** You said "等下我查查" earlier, other messages arrived while you worked, and now you are delivering the answer to the original requester's `#N`.

2. **Omit `reply_to` when:**
   - You are replying immediately to the very last message in a calm 1-on-1 or single-topic conversation.
   - You are making a general comment to the whole group.
   - You already quoted the same message moments ago.

## Reading Incoming Quotes

When another member quote-replies a message, their line in the chat log includes a `(quote ...)` tag:

- `(quote @me: ...)`: They quoted one of **your** earlier messages. Treat this as a direct reply to you even if they did not `@`-mention you.
- `(quote #14: 阿明: ...)`: They quoted message `#14`.
- `(quote: 阿明: ...)`: They quoted an older message whose preview is shown.

## Combining Quote-Replies with Multi-Person Batches

When a batch contains messages from multiple people:
- Prefer **one natural message** addressing what matters, or quote the earlier/ambiguous message (`reply_to: 14`) while addressing the latest speaker by `@nickname` in the text if needed.
- Only split into two `qq_send` calls (each quoting its respective `#N`) when the two topics are completely separate and combining them into one sentence would read awkwardly.
