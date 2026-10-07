# pi-video-analyser

A [Pi](https://pi.dev) extension that adds a `video_analyse` tool: it sends a
local video file and a prompt to a model already configured in Pi (through any
OpenAI-compatible provider) and returns the analysis as text.

## How it works

Pi's internal model pipeline has no video content block, so the tool calls the
provider's OpenAI-compatible `chat/completions` endpoint directly with the
[openai SDK], reusing the credentials, headers, and base URL Pi has already
resolved for that provider (`getApiKeyAndHeaders`). The video travels as a
base64 `video_url` data URL, the convention used by OpenRouter, vLLM, Google's
OpenAI-compat layer, and other compatible endpoints.

[openai SDK]: https://www.npmjs.com/package/openai

## Install

```sh
pi add npm:pi-video-analyser
```

Or from a git checkout:

```sh
pi add /path/to/pi-video-analyser
```

## Configure

Run the settings wizard in an interactive Pi session:

```
/pi-video-analyser:settings
```

The model picker is searchable: type to fuzzy-filter (e.g. `gemini flash`,
`gpt4o`) over `provider / model-id` and the model's display name, navigate with
the arrow keys, and press Enter to select. The saved model is marked
`current`; providers without credentials are marked `no auth`. In RPC
sessions (no custom components), the wizard asks for a search query first and
then lists the matching models.

It persists to `~/.pi/agent/pi-video-analyser.json`:

| Setting         | Default | Range     | Meaning                                |
| --------------- | ------- | --------- | -------------------------------------- |
| model           | —       | —         | Any model on an OpenAI-compatible provider (openai, openrouter, vLLM, Ollama, custom `models.json` entries, …) |
| max video size  | 50 MB   | 1–500     | Hard cap; larger files fail fast       |
| timeout         | 300 s   | 5–3600    | Request timeout for the analysis call  |

The model picker only lists providers whose API is `openai-completions` or
`openai-responses`; native Anthropic/Google/Azure providers are excluded
because their endpoints do not speak the OpenAI chat-completions protocol that
this tool uses. The tool always targets the provider's `chat/completions`
endpoint, so models on `openai-responses` providers (OpenAI itself, xAI,
gateways) rely on that endpoint being exposed as well — every provider in
Pi's catalog does, but a custom Responses-only endpoint fails with an error
suggesting an `openai-completions` model instead.

## Use

Ask the agent, for example:

> Use video_analyse on ./demo.mp4 and summarise what happens with timestamps.

Tool parameters:

- `path` — local video file (`.mp4`, `.webm`, `.mov`, `.m4v`, `.mkv`)
- `prompt` — what to analyse

Token usage reported by the endpoint is folded into the session totals.

## Failure modes

| Situation                        | Behaviour                                                        |
| -------------------------------- | ---------------------------------------------------------------- |
| Video over the size limit        | Error with actual size, the limit, and where to change it        |
| Unsupported extension / no file  | Error listing accepted formats / the resolved path               |
| No model configured (yet)        | Error pointing at `/pi-video-analyser:settings`                  |
| Model removed / no credentials   | Error naming the provider and the fix (`/login`, re-run settings)|
| Endpoint rejects `video_url`     | Provider error passed through with a hint                        |
| Timeout / aborted turn           | Clear timeout/abort message; the upload is never retried         |

The tool itself works in headless modes (`pi -p …`); only the settings wizard
requires an interactive session.

## Development

```sh
npm install
npm run typecheck
pi --extension .   # load straight from the checkout
```

## License

MIT
