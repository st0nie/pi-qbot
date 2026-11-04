---
name: qq-mention
description: Use when @-mentioning or addressing members in a QQ group chat — covers the at parameter in qq_send, @nickname in text, QQ platform automatic @ behavior, and avoiding raw IDs or XML mention tags.
---

# `@`-Mentioning People in QQ Group Chats

## How Incoming `@` Mentions Look

In the chat log you receive:

```text
[21:05:01] #20 阿明(a1b2c3d4) (@me): @小Q 帮我看下这个报错
[21:05:04] #21 小红(e5f6a7b8): @阿明 你是不是没装依赖
```

- `(@me)` before the colon means the sender `@`-mentioned you.
- Inside the message text, `<@!...>` tags are already decoded to readable `@nickname` (or `@everyone`).
- The string in parentheses — e.g. `(a1b2c3d4)` or `(a1b2c3d4,admin)` — is an internal hash and role tag for distinguishing members with similar names. **Never** include `(a1b2c3d4)` when talking.

## How to `@`-Mention Someone When Replying

You have two equivalent ways to `@`-mention people in `qq_send`:

### 1. Using the `at` parameter in `qq_send` (Recommended)

Pass a nickname, a `#N` message reference, or an array of them in `at`:

```json
{
  "text": "你看看是不是 lockfile 没更新",
  "at": "阿明",
  "reply_to": 20
}
```

Or using the message number `#20` (automatically resolves to the sender's nickname):

```json
{
  "text": "你看看是不是 lockfile 没更新",
  "at": "#20"
}
```

Or mentioning multiple members at once:

```json
{
  "text": "你们俩说的其实是一回事哈哈",
  "at": ["阿明", "小红"]
}
```

`qq_send` automatically prepends `@阿明` (or `@阿明 @小红`) to your message without duplicating it if you already wrote `@阿明` in `text`.

### 2. Writing `@nickname` directly in `text`

You can also write `@nickname` inline anywhere in `text`, which is especially natural when addressing two people in different parts of one sentence:

```json
{
  "text": "@阿明 这个报错是缺环境变量，@小红 刚才发的命令可以直接用"
}
```

## Platform Behavior & Rules (Critical)

1. **QQ Official Bot Platform `@` Rules:**
   - When someone `@`-mentions you (`(@me)`), QQ's server **automatically attaches a native clickable `@sender`** to your passive reply. You do not need to force `@sender` on every single reply to someone who just `@`-mentioned you unless multiple people are talking at once.
   - Official QQ bots cannot send raw `<@!openid>` or `<qqbot-at-user id="..." />` XML tags in group text (QQ displays them as literal text). Always use plain `@nickname` or the `at` parameter.
2. **Never Leak Internal IDs:**
   - Write `@阿明`, **never** `@a1b2c3d4`, `@阿明(a1b2c3d4)`, or `<@a1b2c3d4>`.
3. **Private Chats (`c2c`):**
   - In 1-on-1 private chats, you are only talking to one friend. Do not `@` them; just talk naturally (`"你"`).
