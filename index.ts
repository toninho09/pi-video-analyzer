/**
 * pi-video-analyser
 *
 * Pi extension that adds a `video_analyse` tool: it sends a local video file
 * and a prompt to a model configured in Pi (through any OpenAI-compatible
 * provider) and returns the analysis as text.
 *
 * Configure the model with /pi-video-analyser:settings.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { analyseVideo } from "./lib/analyzer.ts";
import { loadSettings } from "./lib/settings.ts";
import { runSettingsWizard } from "./lib/settings-wizard.ts";

const VideoAnalyseParams = Type.Object({
	path: Type.String({
		description: "Path to a local video file (mp4, webm, mov, m4v, or mkv)",
	}),
	prompt: Type.String({
		description: "What to analyse in the video, e.g. 'describe each scene with timestamps'",
	}),
});

export default function videoAnalyserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "video_analyse",
		label: "Video Analyser",
		description:
			"Analyse a local video file with a vision-capable model. " +
			"Takes a file path and a prompt describing what to look for, and returns the model's analysis as text.",
		promptSnippet: "Analyse a local video file with a prompt; returns the analysis as text.",
		parameters: VideoAnalyseParams,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		// Each call holds the whole video in memory; avoid several at once.
		executionMode: "sequential",

		renderCall: (args, theme) => ({
			// Arguments stream in, so path may not be there yet.
			render: (width: number) => [
				truncateToWidth(`${theme.fg("accent", "video_analyse")} ${args.path ?? ""}`, width),
			],
			invalidate: () => {},
		}),

		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const settings = loadSettings();
			const result = await analyseVideo(
				ctx.modelRegistry,
				settings,
				ctx.cwd,
				params.path,
				params.prompt,
				signal,
			);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					model: result.model,
					path: params.path,
					bytes: result.bytes,
					durationMs: result.durationMs,
				},
				usage: result.usage,
			};
		},
	});

	pi.registerCommand("pi-video-analyser:settings", {
		description: "Configure the video_analyse tool (model, size limit, timeout)",
		handler: async (_args, ctx) => runSettingsWizard(ctx),
	});
}
