/**
 * Video analysis through an OpenAI-compatible chat-completions endpoint.
 *
 * Pi's normalized model pipeline has no video content block, so this module
 * calls the endpoint directly with the openai SDK, reusing the credentials,
 * headers, and base URL that Pi already resolved for the chosen provider.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { VideoAnalyserSettings } from "./settings";

/** File extensions accepted by the tool, mapped to their MIME type. */
const VIDEO_MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/x-m4v",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
};

const SETTINGS_HINT = "Run /pi-video-analyser:settings to pick one.";

export interface AnalyseResult {
	/** The analysis text returned by the model. */
	text: string;
	/** "provider/modelId" that produced the analysis. */
	model: string;
	/** Size of the analysed file in bytes. */
	bytes: number;
	/** Wall-clock duration of the request in milliseconds. */
	durationMs: number;
	/** Token usage reported by the endpoint, if any. */
	usage?: Usage;
}

function formatMb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("\n")
			.trim();
	}
	return "";
}

function mapUsage(usage: OpenAI.CompletionUsage | null | undefined): Usage | undefined {
	if (!usage) {
		return undefined;
	}
	const input = usage.prompt_tokens ?? 0;
	const output = usage.completion_tokens ?? 0;
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: usage.total_tokens ?? input + output,
		// Cost stays zero: prices come from Pi's catalog, which this direct
		// call does not consult. Token counts still land in session totals.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Validate the video file and run the analysis prompt against it.
 * Throws with user-actionable messages on every failure mode.
 */
export async function analyseVideo(
	registry: ModelRegistry,
	settings: VideoAnalyserSettings,
	videoPath: string,
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<AnalyseResult> {
	if (!settings.provider || !settings.modelId) {
		throw new Error(`No model configured for video analysis. ${SETTINGS_HINT}`);
	}

	const model = registry.find(settings.provider, settings.modelId);
	if (!model) {
		throw new Error(
			`Model ${settings.provider}/${settings.modelId} is no longer available. ${SETTINGS_HINT}`,
		);
	}
	if (!registry.hasConfiguredAuth(model)) {
		throw new Error(
			`No authentication configured for provider "${settings.provider}". Run /login or set its API key.`,
		);
	}

	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(`Could not resolve credentials for ${settings.provider}: ${auth.error}`);
	}
	const baseUrl = auth.baseUrl ?? model.baseUrl;
	if (!baseUrl) {
		throw new Error(`Provider "${settings.provider}" exposes no base URL for direct calls.`);
	}

	const resolvedPath = path.resolve(videoPath);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Video file not found: ${resolvedPath}`);
	}
	const stat = statSync(resolvedPath);
	if (!stat.isFile()) {
		throw new Error(`Not a regular file: ${resolvedPath}`);
	}
	if (stat.size === 0) {
		throw new Error(`Video file is empty: ${resolvedPath}`);
	}
	const mime = VIDEO_MIME[path.extname(resolvedPath).toLowerCase()];
	if (!mime) {
		throw new Error(
			`Unsupported video format "${path.extname(resolvedPath) || path.basename(resolvedPath)}". Supported: ${Object.keys(VIDEO_MIME).join(", ")}.`,
		);
	}
	const maxBytes = settings.maxVideoMb * 1024 * 1024;
	if (stat.size > maxBytes) {
		throw new Error(
			`Video is ${formatMb(stat.size)} MB, over the ${settings.maxVideoMb} MB limit. ` +
				`Raise the limit with /pi-video-analyser:settings or use a smaller file.`,
		);
	}

	// Async read keeps the TUI responsive while large files load.
	const dataUrl = `data:${mime};base64,${(await readFile(resolvedPath)).toString("base64")}`;
	const client = new OpenAI({
		apiKey: auth.apiKey ?? "",
		baseURL: baseUrl,
		defaultHeaders: auth.headers,
		// Retries would re-upload the whole video; fail fast instead.
		maxRetries: 0,
	});

	const request = {
		model: model.id,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: prompt },
					{ type: "video_url", video_url: { url: dataUrl } },
				],
			},
		],
	};

	const startedAt = Date.now();
	let response: OpenAI.Chat.ChatCompletion;
	try {
		response = await client.chat.completions.create(
			// `video_url` parts are the de-facto convention for video input on
			// OpenAI-compatible endpoints, but are not in the SDK's types yet.
			request as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
			{ timeout: settings.timeoutSeconds * 1000, signal },
		);
	} catch (error) {
		if (signal?.aborted || error instanceof OpenAI.APIUserAbortError) {
			throw new Error("Video analysis was aborted.");
		}
		if (error instanceof OpenAI.APIConnectionTimeoutError) {
			throw new Error(`Video analysis timed out after ${settings.timeoutSeconds}s.`);
		}
		if (error instanceof OpenAI.APIError) {
			const status = error.status ? ` [HTTP ${error.status}]` : "";
			const responsesHint =
				model.api === "openai-responses" && error.status === 404
					? " This provider is registered for the Responses API and its endpoint may not expose chat/completions — pick a model on an openai-completions provider instead."
					: "";
			throw new Error(
				`${error.message}${status} — the endpoint may not accept video_url input for ${model.id}.${responsesHint}`,
			);
		}
		throw error instanceof Error ? error : new Error(String(error));
	}

	const text = extractText(response.choices[0]?.message?.content);
	return {
		text: text || "(The model returned an empty response.)",
		model: `${model.provider}/${model.id}`,
		bytes: stat.size,
		durationMs: Date.now() - startedAt,
		usage: mapUsage(response.usage),
	};
}
