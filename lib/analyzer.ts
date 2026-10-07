/**
 * Video analysis through an OpenAI-compatible chat-completions endpoint.
 *
 * Pi's normalized model pipeline has no video content block, so this module
 * calls the endpoint directly with the openai SDK, reusing the credentials,
 * headers, and base URL that Pi already resolved for the chosen provider.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import OpenAI from "openai";
import type { VideoAnalyserSettings } from "./settings.ts";

/** File extensions accepted by the tool, mapped to their MIME type. */
const VIDEO_MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/x-m4v",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
};

/** HTTP statuses that typically mean the endpoint rejected the video payload itself. */
const VIDEO_REJECTION_STATUSES = new Set([400, 415, 422]);

const SETTINGS_HINT = "Run /pi-video-analyser:settings to pick one.";
const ABORTED_MESSAGE = "Video analysis was aborted.";

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

export interface VideoFile {
	path: string;
	mime: string;
	bytes: number;
}

function formatMb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

/** Resolve a user-supplied path against the session cwd, expanding a leading "~". */
export function resolveVideoPath(videoPath: string, cwd: string): string {
	const expanded =
		videoPath === "~" || videoPath.startsWith("~/") ? path.join(homedir(), videoPath.slice(1)) : videoPath;
	return path.resolve(cwd, expanded);
}

/** Check that the file exists, is a supported video, and fits the size limit. */
export async function inspectVideoFile(resolvedPath: string, maxVideoMb: number): Promise<VideoFile> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(resolvedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Video file not found: ${resolvedPath}`);
		}
		throw error;
	}
	if (!stats.isFile()) {
		throw new Error(`Not a regular file: ${resolvedPath}`);
	}
	if (stats.size === 0) {
		throw new Error(`Video file is empty: ${resolvedPath}`);
	}
	const extension = path.extname(resolvedPath);
	const mime = VIDEO_MIME[extension.toLowerCase()];
	if (!mime) {
		throw new Error(
			`Unsupported video format "${extension || path.basename(resolvedPath)}". Supported: ${Object.keys(VIDEO_MIME).join(", ")}.`,
		);
	}
	if (stats.size > maxVideoMb * 1024 * 1024) {
		throw new Error(
			`Video is ${formatMb(stats.size)} MB, over the ${maxVideoMb} MB limit. ` +
				`Raise the limit with /pi-video-analyser:settings or use a smaller file.`,
		);
	}
	return { path: resolvedPath, mime, bytes: stats.size };
}

export function extractText(content: unknown): string {
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

export function mapUsage(usage: OpenAI.CompletionUsage | null | undefined, model: Model<Api>): Usage | undefined {
	if (!usage) {
		return undefined;
	}
	// prompt_tokens includes cached tokens; Pi counts them separately.
	const promptTokens = usage.prompt_tokens ?? 0;
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
	const input = Math.max(0, promptTokens - cacheRead);
	const output = usage.completion_tokens ?? 0;
	const mapped: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: usage.total_tokens ?? promptTokens + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	mapped.cost = calculateCost(model, mapped);
	return mapped;
}

/**
 * Validate the video file and run the analysis prompt against it.
 * Throws with user-actionable messages on every failure mode.
 */
export async function analyseVideo(
	registry: ModelRegistry,
	settings: VideoAnalyserSettings,
	cwd: string,
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

	// Keyless endpoints (local vLLM/Ollama) resolve fine here without stored credentials.
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(
			`Could not resolve credentials for "${settings.provider}": ${auth.error}. Run /login or set its API key.`,
		);
	}
	const baseUrl = auth.baseUrl ?? model.baseUrl;
	if (!baseUrl) {
		throw new Error(`Provider "${settings.provider}" exposes no base URL for direct calls.`);
	}

	const video = await inspectVideoFile(resolveVideoPath(videoPath, cwd), settings.maxVideoMb);

	let data: Buffer;
	try {
		data = await readFile(video.path, { signal });
	} catch (error) {
		if (signal?.aborted) {
			throw new Error(ABORTED_MESSAGE);
		}
		throw error;
	}
	const dataUrl = `data:${video.mime};base64,${data.toString("base64")}`;
	const client = new OpenAI({
		// The SDK requires a non-empty key even when Pi authenticates via headers.
		apiKey: auth.apiKey || "unused",
		baseURL: baseUrl,
		defaultHeaders: {
			// Never send the placeholder key; Pi's resolved headers take precedence.
			...(!auth.apiKey ? { Authorization: null } : {}),
			...auth.headers,
		},
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
			throw new Error(ABORTED_MESSAGE);
		}
		if (error instanceof OpenAI.APIConnectionTimeoutError) {
			throw new Error(`Video analysis timed out after ${settings.timeoutSeconds}s.`);
		}
		if (error instanceof OpenAI.APIError) {
			const hints: string[] = [];
			if (error.status && VIDEO_REJECTION_STATUSES.has(error.status)) {
				hints.push(`The endpoint may not accept video_url input for ${model.id}.`);
			}
			if (model.api === "openai-responses" && error.status === 404) {
				hints.push(
					"This provider is registered for the Responses API and its endpoint may not expose chat/completions — pick a model on an openai-completions provider instead.",
				);
			}
			const status = error.status ? ` [HTTP ${error.status}]` : "";
			const hint = hints.length > 0 ? ` — ${hints.join(" ")}` : "";
			throw new Error(`${error.message}${status}${hint}`);
		}
		throw error instanceof Error ? error : new Error(String(error));
	}

	const text = extractText(response.choices[0]?.message?.content);
	return {
		text: text || "(The model returned an empty response.)",
		model: `${model.provider}/${model.id}`,
		bytes: video.bytes,
		durationMs: Date.now() - startedAt,
		usage: mapUsage(response.usage, model),
	};
}
