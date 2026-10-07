import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { analyseVideo, extractText, inspectVideoFile, mapUsage, resolveVideoPath } from "../lib/analyzer.ts";

const dir = mkdtempSync(path.join(tmpdir(), "pi-video-analyser-"));

function writeFile(name: string, bytes: number): string {
	const file = path.join(dir, name);
	writeFileSync(file, Buffer.alloc(bytes, 1));
	return file;
}

test("resolveVideoPath resolves relative paths against the session cwd", () => {
	assert.equal(resolveVideoPath("clip.mp4", "/work/project"), "/work/project/clip.mp4");
	assert.equal(resolveVideoPath("/abs/clip.mp4", "/work/project"), "/abs/clip.mp4");
});

test("resolveVideoPath expands a leading ~", () => {
	assert.equal(resolveVideoPath("~/Movies/clip.mp4", "/work"), path.join(homedir(), "Movies/clip.mp4"));
	assert.equal(resolveVideoPath("~other/clip.mp4", "/work"), "/work/~other/clip.mp4");
});

test("inspectVideoFile accepts a supported video under the limit", async () => {
	const file = writeFile("ok.MP4", 10);
	assert.deepEqual(await inspectVideoFile(file, 1), { path: file, mime: "video/mp4", bytes: 10 });
});

test("inspectVideoFile rejects missing, empty, unsupported, and oversized files", async () => {
	await assert.rejects(inspectVideoFile(path.join(dir, "missing.mp4"), 1), /not found/);
	await assert.rejects(inspectVideoFile(dir, 1), /Not a regular file/);
	await assert.rejects(inspectVideoFile(writeFile("empty.mp4", 0), 1), /empty/);
	await assert.rejects(inspectVideoFile(writeFile("clip.avi", 10), 1), /Unsupported video format "\.avi"/);
	await assert.rejects(inspectVideoFile(writeFile("big.mp4", 1024 * 1024 + 1), 1), /over the 1 MB limit/);
});

test("extractText handles strings, content parts, and unknown shapes", () => {
	assert.equal(extractText("hello"), "hello");
	assert.equal(extractText([{ text: "a" }, { image: "x" }, { text: "b" }]), "a\n\nb");
	assert.equal(extractText(null), "");
});

test("mapUsage separates cached tokens from input and prices the call", () => {
	const model = {
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
	} as unknown as Model<Api>;
	const usage = mapUsage(
		{
			prompt_tokens: 1_000_000,
			completion_tokens: 500_000,
			total_tokens: 1_500_000,
			prompt_tokens_details: { cached_tokens: 200_000 },
		},
		model,
	);
	assert.equal(usage?.input, 800_000);
	assert.equal(usage?.cacheRead, 200_000);
	assert.equal(usage?.output, 500_000);
	assert.equal(usage?.totalTokens, 1_500_000);
	assert.equal(usage?.cost.total, 1.9);
	assert.equal(mapUsage(undefined, model), undefined);
});

const authCases: {
	name: string;
	auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
	expectedAuthorization: string | null;
}[] = [
	{
		name: "API key",
		auth: { ok: true, apiKey: "test-api-key" },
		expectedAuthorization: "Bearer test-api-key",
	},
	{
		name: "Authorization header only",
		auth: { ok: true, headers: { authorization: "Bearer test-header-token" } },
		expectedAuthorization: "Bearer test-header-token",
	},
	{
		name: "custom authentication header only",
		auth: { ok: true, headers: { "x-api-key": "test-custom-key" } },
		expectedAuthorization: null,
	},
	{
		name: "keyless endpoint",
		auth: { ok: true },
		expectedAuthorization: null,
	},
	{
		name: "empty API key",
		auth: { ok: true, apiKey: "" },
		expectedAuthorization: null,
	},
];

for (const { name, auth, expectedAuthorization } of authCases) {
	test(`analyseVideo sends resolved credentials for ${name}`, async (t) => {
		const model = {
			provider: "test-provider",
			id: "video-model",
			api: "openai-completions",
			baseUrl: "https://test.invalid/v1",
		} as Model<Api>;
		const registry = {
			find: () => model,
			getApiKeyAndHeaders: async () => auth,
		} as unknown as ModelRegistry;
		const fetchMock = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
			assert.equal(String(url), "https://test.invalid/v1/chat/completions");
			const headers = new Headers(init.headers);
			assert.equal(headers.get("authorization"), expectedAuthorization);
			assert.equal(headers.get("x-api-key"), auth.ok ? (auth.headers?.["x-api-key"] ?? null) : null);
			const body = JSON.parse(String(init.body));
			assert.equal(body.model, model.id);
			assert.deepEqual(body.messages[0].content, [
				{ type: "text", text: "Describe the video" },
				{ type: "video_url", video_url: { url: "data:video/mp4;base64,AQ==" } },
			]);
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "Test analysis" }, finish_reason: "stop" }] }),
				{ headers: { "content-type": "application/json" } },
			);
		});

		const result = await analyseVideo(
			registry,
			{ provider: model.provider, modelId: model.id, maxVideoMb: 1, timeoutSeconds: 5 },
			dir,
			writeFile("auth.mp4", 1),
			"Describe the video",
			undefined,
		);
		assert.equal(result.text, "Test analysis");
		assert.equal(fetchMock.mock.callCount(), 1);
	});
}

