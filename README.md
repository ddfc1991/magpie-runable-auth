# magpie-runable-auth

Magpie provider plugin: **Runable** (Claude models via a Runable session token).

Runable's `/api/chat/text` is a custom SSE endpoint (not OpenAI-compatible). This plugin
translates OpenAI chat completions `<->` Runable SSE inside its `fetch`, so Magpie serves
the three Claude models under the Runable provider.

## Models

- `anthropic/claude-sonnet-5.5` — Claude Sonnet 5.5
- `anthropic/claude-sonnet-5.0` — Claude Sonnet 5
- `anthropic/claude-haiku-5.5` — Claude Haiku 5.5

## Install

```
magpie n github:ddfc1991/magpie-runable-auth
```

Then sign in to **Runable** (provider card → sign in → paste your Runable session token).

## Sign-in

The provider takes an API-style **Runable session token** (the `token` in the user's
Runable session). Requests are sent with `Authorization: Bearer <token>` to
`api.runable.com/api/chat/text`.

No secrets are stored in this repo.
