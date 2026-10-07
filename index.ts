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
import { fuzzyFilter, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { analyseVideo } from "./lib/analyzer";
import { InputDialogComponent } from "./lib/input-dialog";
import { SearchPickerComponent, type PickerItem } from "./lib/model-picker";
import {
	MAX_VIDEO_MB_RANGE,
	TIMEOUT_SECONDS_RANGE,
	loadSettings,
	saveSettings,
	settingsFilePath,
} from "./lib/settings";

/** pi APIs whose providers expose an OpenAI-compatible chat-completions endpoint we can call directly. */
const COMPATIBLE_APIS = new Set(["openai-completions", "openai-responses"]);

/** With more candidates than this, non-TUI sessions must search before selecting. */
const DIRECT_SELECT_LIMIT = 30;

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

		renderCall: (args, theme) => ({
			render: (width: number) => [
				truncateToWidth(`${theme.fg("accent", "video_analyse")} ${args.path}`, width),
			],
			invalidate: () => {},
		}),

		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const settings = loadSettings();
			const result = await analyseVideo(ctx.modelRegistry, settings, params.path, params.prompt, signal);
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
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/pi-video-analyser:settings needs an interactive session.", "error");
				return;
			}

			const settings = loadSettings();
			const models = ctx.modelRegistry
				.getAll()
				.filter((model) => COMPATIBLE_APIS.has(model.api))
				.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));

			if (models.length === 0) {
				ctx.ui.notify(
					"No OpenAI-compatible models found. Use /login to add a provider first.",
					"error",
				);
				return;
			}

			const currentId = settings.provider && settings.modelId ? `${settings.provider}\0${settings.modelId}` : undefined;
			const items: PickerItem[] = models.map((model) => ({
				id: `${model.provider}\0${model.id}`,
				label: `${model.provider} / ${model.id}`,
				detail: model.name,
				badges: [
					...(currentId === `${model.provider}\0${model.id}` ? ["current"] : []),
					...(ctx.modelRegistry.hasConfiguredAuth(model) ? [] : ["no auth"]),
				],
			}));

			const currentSummary =
				settings.provider && settings.modelId
					? `Current: ${settings.provider}/${settings.modelId} · max ${settings.maxVideoMb} MB · timeout ${settings.timeoutSeconds}s`
					: "Current: not configured";

			let chosenId: string | undefined;
			if (ctx.mode === "tui") {
				// Searchable picker with type-to-filter (same pattern as /model).
				chosenId = await ctx.ui.custom(
					(tui, theme, keybindings, done) =>
						new SearchPickerComponent({
							items,
							theme,
							keybindings,
							tui,
							done,
							initialSelectedId: currentId,
							title: "Model for video analysis",
							subtitle: currentSummary,
						}),
				);
			} else {
				// RPC fallback: search with a text prompt, then pick from the matches.
				ctx.ui.notify(currentSummary, "info");
				let matches = items;
				while (true) {
					if (matches.length > DIRECT_SELECT_LIMIT) {
						const query = await ctx.ui.input("Search models (fuzzy match)", "e.g. gemini");
						if (query === undefined) return;
						matches = query.trim()
							? fuzzyFilter(items, query.trim(), (item) => item.searchText ?? item.label)
							: items;
						if (matches.length === 0) {
							ctx.ui.notify(`No models match "${query.trim()}".`, "warning");
							continue;
						}
						if (matches.length > DIRECT_SELECT_LIMIT) {
							ctx.ui.notify(`${matches.length} matches — refine the search.`, "warning");
							continue;
						}
					}
					const labels = matches.map((item) =>
						item.badges?.length ? `${item.label} (${item.badges.join(", ")})` : item.label,
					);
					const chosen = await ctx.ui.select("Model for video analysis", labels);
					if (chosen === undefined) return;
					const index = labels.indexOf(chosen);
					if (index < 0) return;
					chosenId = matches[index].id;
					break;
				}
			}
			if (chosenId === undefined) return;
			const chosenModel = models.find((m) => `${m.provider}\0${m.id}` === chosenId);
			if (!chosenModel) return;

			// Ask for an integer in range, pre-filled with the current value
			// (ctx.ui.input only takes a placeholder, so TUI uses a custom dialog).
			// Invalid input re-asks; only an explicit cancel aborts the wizard.
			const askInteger = async (
				title: string,
				range: readonly [number, number],
				current: number,
			): Promise<number | undefined> => {
				while (true) {
					let raw: string | undefined;
					if (ctx.mode === "tui") {
						raw = await ctx.ui.custom(
							(tui, theme, keybindings, done) =>
								new InputDialogComponent({
									title: `${title} (${range[0]}-${range[1]})`,
									initialValue: String(current),
									theme,
									keybindings,
									tui,
									done,
								}),
						);
					} else {
						raw = await ctx.ui.input(`${title} (${range[0]}-${range[1]})`, String(current));
					}
					if (raw === undefined) return undefined;
					const parsed = Number(raw.trim());
					if (Number.isInteger(parsed) && parsed >= range[0] && parsed <= range[1]) {
						return parsed;
					}
					ctx.ui.notify(
						`Invalid value for "${title}": "${raw.trim()}" — expected an integer between ${range[0]} and ${range[1]}.`,
						"error",
					);
				}
			};

			const maxVideoMb = await askInteger("Max video size in MB", MAX_VIDEO_MB_RANGE, settings.maxVideoMb);
			if (maxVideoMb === undefined) return;
			const timeoutSeconds = await askInteger(
				"Request timeout in seconds",
				TIMEOUT_SECONDS_RANGE,
				settings.timeoutSeconds,
			);
			if (timeoutSeconds === undefined) return;

			saveSettings({
				provider: chosenModel.provider,
				modelId: chosenModel.id,
				maxVideoMb,
				timeoutSeconds,
			});
			const savedMessage = `Saved: ${chosenModel.provider}/${chosenModel.id}, max ${maxVideoMb} MB, timeout ${timeoutSeconds}s → ${settingsFilePath()}`;
			if (ctx.modelRegistry.hasConfiguredAuth(chosenModel)) {
				ctx.ui.notify(savedMessage, "info");
			} else {
				ctx.ui.notify(
					`${savedMessage} — warning: no credentials for "${chosenModel.provider}" yet, run /login before using video_analyse.`,
					"warning",
				);
			}
		},
	});
}
