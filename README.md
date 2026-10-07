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
`current`. Only models Pi reports as available with configured authentication
are listed; sign in with `/login` or configure credentials in Pi first. In RPC
sessions (no custom components), the wizard asks for a search query when there
are more than 30 models and then lists the matches. A search with no matches
asks again, so you can refine it or cancel.

Each numeric prompt is pre-filled with the current value; submitting it empty
keeps the current value.

It persists to `pi-video-analyser.json` in Pi's agent directory
(`~/.pi/agent/` by default, or `$PI_CODING_AGENT_DIR`):

| Setting         | Default | Range     | Meaning                                |
| --------------- | ------- | --------- | -------------------------------------- |
| model           | —       | —         | An available, authenticated model on an OpenAI-compatible provider |
| max video size  | 50 MB   | 1–350     | Hard cap; larger files fail fast       |
| timeout         | 300 s   | 5–3600    | Request timeout for the analysis call  |

Out-of-range values in a hand-edited file are clamped to the range; a file
that is not valid JSON makes the tool fail with the path to fix (re-running
the wizard overwrites it).

The 350 MB ceiling comes from the transport: the video is sent base64-encoded
inside the JSON request, and Node cannot build strings much past ~384 MB of
raw video. Most providers accept far less inline — some OpenAI-compatible
endpoints cap request bodies around 20 MB — so check your provider's limit
before raising the default.

The model picker only lists providers whose API is `openai-completions` or
`openai-responses`; native Anthropic/Google/Azure providers are excluded
because their endpoints do not speak the OpenAI chat-completions protocol that
this tool uses. The tool always targets the provider's `chat/completions`
endpoint, so models on `openai-responses` providers (OpenAI itself, xAI,
gateways) rely on that endpoint being exposed as well — every provider in
Pi's catalog does, but a custom Responses-only endpoint fails with an error
suggesting an `openai-completions` model instead.

Being on a compatible API does not mean the model accepts video: Pi's
catalog only tracks text and image input, so the picker cannot filter by
video support. Pick a model whose provider documents video input (e.g.
Gemini models via OpenRouter or Google's OpenAI-compat layer); OpenAI's own
chat models do not accept `video_url`.

## Use

Ask the agent, for example:

> Use video_analyse on ./demo.mp4 and summarise what happens with timestamps.

Tool parameters:

- `path` — local video file (`.mp4`, `.webm`, `.mov`, `.m4v`, `.mkv`),
  relative to the session's working directory; a leading `~` is expanded
- `prompt` — what to analyse

Token usage reported by the endpoint, and its cost from Pi's model catalog,
are folded into the session totals. Calls run one at a time, since each holds
the whole video in memory.

## Failure modes

| Situation                        | Behaviour                                                        |
| -------------------------------- | ---------------------------------------------------------------- |
| Video over the size limit        | Error with actual size, the limit, and where to change it        |
| Unsupported extension / no file  | Error listing accepted formats / the resolved path               |
| No model configured (yet)        | Error pointing at `/pi-video-analyser:settings`                  |
| Settings file is not valid JSON  | Error with the file path; the wizard starts from defaults        |
| Model removed / no credentials   | Error naming the provider and the fix (`/login`, re-run settings)|
| Endpoint rejects `video_url`     | Provider error passed through; HTTP 400/415/422 add a video hint |
| Timeout / aborted turn           | Clear timeout/abort message; the upload is never retried         |

The tool itself works in headless modes (`pi -p …`); only the settings wizard
requires an interactive session.

## Development

```sh
npm install
npm run typecheck
npm test
pi --extension .   # load straight from the checkout
```

## License

MIT
