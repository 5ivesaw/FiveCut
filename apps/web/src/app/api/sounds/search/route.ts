import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { webEnv } from "@/lib/env/web";

const searchParamsSchema = z.object({
	q: z.string().trim().max(200, "Query too long").optional(),
	type: z.enum(["songs", "effects"]).default("effects"),
	page: z.coerce.number().int().min(1).max(100).default(1),
	page_size: z.coerce.number().int().min(1).max(50).default(20),
	commercial_only: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
});

const openverseAudioSchema = z.object({
	id: z.string(),
	title: z.string().nullable().optional(),
	foreign_landing_url: z.url(),
	url: z.url(),
	creator: z.string().nullable().optional(),
	license: z.string(),
	license_url: z.url().nullable().optional(),
	filesize: z.number().nullable().optional(),
	filetype: z.string().nullable().optional(),
	tags: z
		.array(
			z.object({
				name: z.string(),
			}),
		)
		.default([]),
	attribution: z.string().nullable().optional(),
	duration: z.number().nullable().optional(),
	bit_rate: z.number().nullable().optional(),
	sample_rate: z.number().nullable().optional(),
	indexed_on: z.string().optional(),
});

const openverseResponseSchema = z.object({
	result_count: z.number(),
	page_count: z.number(),
	page_size: z.number(),
	page: z.number(),
	results: z.array(openverseAudioSchema),
});

type SoundResult = {
	id: number;
	name: string;
	description: string;
	url: string;
	previewUrl: string;
	downloadUrl: string;
	duration: number;
	filesize: number;
	type: string;
	channels: number;
	bitrate: number;
	bitdepth: number;
	samplerate: number;
	username: string;
	tags: string[];
	license: string;
	created: string;
	downloads: number;
	rating: number;
	ratingCount: number;
};

const LOCAL_SOUNDS: SoundResult[] = [
	{
		id: -1,
		name: "Creator Click",
		description: "FiveCut built-in UI click",
		url: "/assets/audio/click.wav",
		previewUrl: "/assets/audio/click.wav",
		downloadUrl: "/assets/audio/click.wav",
		duration: 0.09,
		filesize: 7_900,
		type: "wav",
		channels: 1,
		bitrate: 705_600,
		bitdepth: 16,
		samplerate: 44_100,
		username: "FiveCut",
		tags: ["click", "ui", "button"],
		license: "CC0-1.0",
		created: "2026-07-26",
		downloads: 0,
		rating: 5,
		ratingCount: 1,
	},
	{
		id: -2,
		name: "Clean Pop",
		description: "FiveCut built-in pop accent",
		url: "/assets/audio/pop.wav",
		previewUrl: "/assets/audio/pop.wav",
		downloadUrl: "/assets/audio/pop.wav",
		duration: 0.18,
		filesize: 16_000,
		type: "wav",
		channels: 1,
		bitrate: 705_600,
		bitdepth: 16,
		samplerate: 44_100,
		username: "FiveCut",
		tags: ["pop", "accent", "notification"],
		license: "CC0-1.0",
		created: "2026-07-26",
		downloads: 0,
		rating: 5,
		ratingCount: 1,
	},
	{
		id: -3,
		name: "Marker Beep",
		description: "FiveCut built-in marker beep",
		url: "/assets/audio/marker-beep.wav",
		previewUrl: "/assets/audio/marker-beep.wav",
		downloadUrl: "/assets/audio/marker-beep.wav",
		duration: 0.55,
		filesize: 48_000,
		type: "wav",
		channels: 1,
		bitrate: 705_600,
		bitdepth: 16,
		samplerate: 44_100,
		username: "FiveCut",
		tags: ["beep", "marker", "countdown"],
		license: "CC0-1.0",
		created: "2026-07-26",
		downloads: 0,
		rating: 5,
		ratingCount: 1,
	},
	{
		id: -4,
		name: "Fast Whoosh",
		description: "FiveCut built-in transition whoosh",
		url: "/assets/audio/whoosh.wav",
		previewUrl: "/assets/audio/whoosh.wav",
		downloadUrl: "/assets/audio/whoosh.wav",
		duration: 0.6,
		filesize: 52_000,
		type: "wav",
		channels: 1,
		bitrate: 705_600,
		bitdepth: 16,
		samplerate: 44_100,
		username: "FiveCut",
		tags: ["whoosh", "transition", "swoosh"],
		license: "CC0-1.0",
		created: "2026-07-26",
		downloads: 0,
		rating: 5,
		ratingCount: 1,
	},
	{
		id: -5,
		name: "Low Impact",
		description: "FiveCut built-in cinematic impact",
		url: "/assets/audio/impact.wav",
		previewUrl: "/assets/audio/impact.wav",
		downloadUrl: "/assets/audio/impact.wav",
		duration: 0.42,
		filesize: 37_000,
		type: "wav",
		channels: 1,
		bitrate: 705_600,
		bitdepth: 16,
		samplerate: 44_100,
		username: "FiveCut",
		tags: ["impact", "bass", "cinematic"],
		license: "CC0-1.0",
		created: "2026-07-26",
		downloads: 0,
		rating: 5,
		ratingCount: 1,
	},
	{
		id: -6,
		name: "Short Riser",
		description: "FiveCut built-in short riser",
		url: "/assets/audio/riser.wav",
		previewUrl: "/assets/audio/riser.wav",
		downloadUrl: "/assets/audio/riser.wav",
		duration: 0.84,
		filesize: 72_000,
		type: "wav",
		channels: 1,
		bitrate: 705_600,
		bitdepth: 16,
		samplerate: 44_100,
		username: "FiveCut",
		tags: ["riser", "transition", "build"],
		license: "CC0-1.0",
		created: "2026-07-26",
		downloads: 0,
		rating: 5,
		ratingCount: 1,
	},
];

function stableNumericId(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function toSoundResult(
	result: z.infer<typeof openverseAudioSchema>,
): SoundResult {
	return {
		id: stableNumericId(result.id),
		name: result.title?.trim() || "Untitled sound",
		description:
			result.attribution ||
			`Openly licensed audio. Source: ${result.foreign_landing_url}`,
		url: result.foreign_landing_url,
		previewUrl: result.url,
		downloadUrl: result.url,
		duration: Math.max(0, (result.duration ?? 0) / 1_000),
		filesize: result.filesize ?? 0,
		type: result.filetype ?? "audio",
		channels: 0,
		bitrate: result.bit_rate ?? 0,
		bitdepth: 0,
		samplerate: result.sample_rate ?? 0,
		username: result.creator?.trim() || "Unknown creator",
		tags: result.tags.slice(0, 24).map((tag) => tag.name),
		license: result.license.toUpperCase(),
		created: result.indexed_on ?? "",
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	};
}

function localResponse({ query = "" }: { query?: string }) {
	const normalizedQuery = query.toLowerCase();
	const results = normalizedQuery
		? LOCAL_SOUNDS.filter((sound) =>
				[sound.name, sound.description, ...sound.tags]
					.join(" ")
					.toLowerCase()
					.includes(normalizedQuery),
			)
		: LOCAL_SOUNDS;
	return {
		count: results.length,
		next: null,
		previous: null,
		results,
		query,
		type: "effects",
		page: 1,
		pageSize: results.length,
		sort: "relevance",
		source: "fivecut-offline",
	};
}

export async function GET(request: NextRequest) {
	const { limited } = await checkRateLimit({ request });
	if (limited) {
		return NextResponse.json({ error: "Too many requests" }, { status: 429 });
	}

	const { searchParams } = new URL(request.url);
	const parsed = searchParamsSchema.safeParse({
		q: searchParams.get("q") || undefined,
		type: searchParams.get("type") || undefined,
		page: searchParams.get("page") || undefined,
		page_size: searchParams.get("page_size") || undefined,
		commercial_only: searchParams.get("commercial_only") || undefined,
	});
	if (!parsed.success) {
		return NextResponse.json(
			{
				error: "Invalid parameters",
				details: parsed.error.flatten().fieldErrors,
			},
			{ status: 400 },
		);
	}

	const { q, type, page, page_size: pageSize, commercial_only } = parsed.data;
	if (webEnv.FIVECUT_OFFLINE) {
		return NextResponse.json(localResponse({ query: q }));
	}

	const query =
		q ||
		(type === "songs"
			? "background music instrumental"
			: "sound effect whoosh impact");
	const licenses = commercial_only
		? "cc0,pdm,by,by-sa"
		: "cc0,pdm,by,by-sa,by-nc,by-nc-sa";
	const params = new URLSearchParams({
		q: query,
		page: page.toString(),
		page_size: Math.min(pageSize, 20).toString(),
		license: licenses,
	});
	if (type === "songs") {
		params.set("category", "music");
	}

	try {
		const response = await fetch(
			`https://api.openverse.org/v1/audio/?${params.toString()}`,
			{
				headers: {
					"User-Agent":
						"FiveCut/0.1 (+https://github.com/5ivesaw/FiveCut)",
				},
				signal: AbortSignal.timeout(8_000),
				next: { revalidate: 3_600 },
			},
		);
		if (!response.ok) {
			throw new Error(`Openverse returned HTTP ${response.status}`);
		}

		const validated = openverseResponseSchema.safeParse(await response.json());
		if (!validated.success) {
			throw new Error("Openverse returned an unsupported response");
		}

		const remoteResults = validated.data.results
			.filter((result) => (result.duration ?? 0) > 0)
			.map(toSoundResult);
		const results =
			page === 1 && type === "effects"
				? [...LOCAL_SOUNDS, ...remoteResults]
				: remoteResults;
		return NextResponse.json({
			count:
				validated.data.result_count +
				(page === 1 && type === "effects" ? LOCAL_SOUNDS.length : 0),
			next:
				page < validated.data.page_count
					? `/api/sounds/search?${new URLSearchParams({
							...Object.fromEntries(params),
							page: (page + 1).toString(),
						}).toString()}`
					: null,
			previous: page > 1 ? "previous" : null,
			results,
			query: q ?? "",
			type,
			page,
			pageSize: validated.data.page_size,
			sort: "relevance",
			source: "openverse",
		});
	} catch (error) {
		console.warn("Open media search unavailable; using offline sounds", error);
		return NextResponse.json({
			...localResponse({ query: q }),
			offlineFallback: true,
		});
	}
}

export const runtime = "nodejs";
