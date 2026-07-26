import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { webEnv } from "@/lib/env/web";

const paramsSchema = z.object({
	q: z.string().trim().max(200).optional(),
	page: z.coerce.number().int().min(1).max(100).default(1),
	page_size: z.coerce.number().int().min(1).max(20).default(20),
	commercial_only: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
});

const openverseImageSchema = z.object({
	id: z.string(),
	title: z.string().nullable().optional(),
	foreign_landing_url: z.url(),
	url: z.url(),
	thumbnail: z.url().nullable().optional(),
	creator: z.string().nullable().optional(),
	license: z.string(),
	license_url: z.url().nullable().optional(),
	attribution: z.string().nullable().optional(),
	width: z.number().nullable().optional(),
	height: z.number().nullable().optional(),
	filesize: z.number().nullable().optional(),
	filetype: z.string().nullable().optional(),
});

const openverseResponseSchema = z.object({
	result_count: z.number(),
	page_count: z.number(),
	page_size: z.number(),
	page: z.number(),
	results: z.array(openverseImageSchema),
});

const LOCAL_IMAGES = [
	{
		id: "local:safety-grid",
		name: "Safety Grid",
		creator: "FiveCut",
		license: "CC0-1.0",
		attribution: "FiveCut built-in asset — CC0-1.0",
		sourceUrl: "/assets/backgrounds/safety-grid.svg",
		thumbnailUrl: "/assets/backgrounds/safety-grid.svg",
		downloadUrl: "/assets/backgrounds/safety-grid.svg",
		width: 1920,
		height: 1080,
		filetype: "svg",
	},
	{
		id: "local:midnight-bloom",
		name: "Midnight Bloom",
		creator: "FiveCut",
		license: "CC0-1.0",
		attribution: "FiveCut built-in asset — CC0-1.0",
		sourceUrl: "/assets/backgrounds/midnight-bloom.svg",
		thumbnailUrl: "/assets/backgrounds/midnight-bloom.svg",
		downloadUrl: "/assets/backgrounds/midnight-bloom.svg",
		width: 1920,
		height: 1080,
		filetype: "svg",
	},
	{
		id: "local:cream-paper",
		name: "Cream Paper",
		creator: "FiveCut",
		license: "CC0-1.0",
		attribution: "FiveCut built-in asset — CC0-1.0",
		sourceUrl: "/assets/backgrounds/cream-paper.svg",
		thumbnailUrl: "/assets/backgrounds/cream-paper.svg",
		downloadUrl: "/assets/backgrounds/cream-paper.svg",
		width: 1920,
		height: 1080,
		filetype: "svg",
	},
	{
		id: "local:halftone-burst",
		name: "Halftone Burst",
		creator: "FiveCut",
		license: "CC0-1.0",
		attribution: "FiveCut built-in asset — CC0-1.0",
		sourceUrl: "/assets/backgrounds/halftone-burst.svg",
		thumbnailUrl: "/assets/backgrounds/halftone-burst.svg",
		downloadUrl: "/assets/backgrounds/halftone-burst.svg",
		width: 1920,
		height: 1080,
		filetype: "svg",
	},
	{
		id: "local:social-neon",
		name: "Social Neon",
		creator: "FiveCut",
		license: "CC0-1.0",
		attribution: "FiveCut built-in asset — CC0-1.0",
		sourceUrl: "/assets/backgrounds/social-neon.svg",
		thumbnailUrl: "/assets/backgrounds/social-neon.svg",
		downloadUrl: "/assets/backgrounds/social-neon.svg",
		width: 1080,
		height: 1920,
		filetype: "svg",
	},
];

function localResults(query?: string) {
	if (!query) return LOCAL_IMAGES;
	const normalized = query.toLowerCase();
	return LOCAL_IMAGES.filter((item) =>
		`${item.name} ${item.creator}`.toLowerCase().includes(normalized),
	);
}

export async function GET(request: NextRequest) {
	const { limited } = await checkRateLimit({ request });
	if (limited) {
		return NextResponse.json({ error: "Too many requests" }, { status: 429 });
	}

	const { searchParams } = new URL(request.url);
	const parsed = paramsSchema.safeParse({
		q: searchParams.get("q") || undefined,
		page: searchParams.get("page") || undefined,
		page_size: searchParams.get("page_size") || undefined,
		commercial_only: searchParams.get("commercial_only") || undefined,
	});
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid parameters", details: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}

	const { q, page, page_size: pageSize, commercial_only } = parsed.data;
	const builtIns = page === 1 ? localResults(q) : [];
	if (webEnv.FIVECUT_OFFLINE) {
		return NextResponse.json({
			count: builtIns.length,
			page: 1,
			pageCount: 1,
			results: builtIns,
			source: "fivecut-offline",
		});
	}

	const params = new URLSearchParams({
		q: q || "abstract background texture",
		page: page.toString(),
		page_size: pageSize.toString(),
		license: commercial_only
			? "cc0,pdm,by,by-sa"
			: "cc0,pdm,by,by-sa,by-nc,by-nc-sa",
	});

	try {
		const response = await fetch(
			`https://api.openverse.org/v1/images/?${params.toString()}`,
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
		const remote = validated.data.results.map((item) => ({
			id: item.id,
			name: item.title?.trim() || "Untitled image",
			creator: item.creator?.trim() || "Unknown creator",
			license: item.license.toUpperCase(),
			attribution:
				item.attribution ||
				`Source and license details: ${item.foreign_landing_url}`,
			sourceUrl: item.foreign_landing_url,
			thumbnailUrl: item.thumbnail || item.url,
			downloadUrl: `/api/library/download?id=${encodeURIComponent(item.id)}`,
			width: item.width || 0,
			height: item.height || 0,
			filesize: item.filesize || 0,
			filetype: item.filetype || "image",
		}));
		return NextResponse.json({
			count: validated.data.result_count + builtIns.length,
			page,
			pageCount: validated.data.page_count,
			results: [...builtIns, ...remote],
			source: "openverse",
		});
	} catch (error) {
		console.warn("Open image search unavailable; using built-in assets", error);
		return NextResponse.json({
			count: builtIns.length,
			page: 1,
			pageCount: 1,
			results: builtIns,
			source: "fivecut-offline",
			offlineFallback: true,
		});
	}
}

export const runtime = "nodejs";
