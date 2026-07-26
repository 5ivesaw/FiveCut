import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const requestSchema = z.object({
	id: z.uuid(),
});

const detailSchema = z.object({
	url: z.url(),
	title: z.string().nullable().optional(),
	filetype: z.string().nullable().optional(),
});

export async function GET(request: NextRequest) {
	const parsed = requestSchema.safeParse({
		id: new URL(request.url).searchParams.get("id"),
	});
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid asset identifier" }, { status: 400 });
	}

	try {
		const detailResponse = await fetch(
			`https://api.openverse.org/v1/images/${parsed.data.id}/`,
			{
				headers: {
					"User-Agent":
						"FiveCut/0.1 (+https://github.com/5ivesaw/FiveCut)",
				},
				signal: AbortSignal.timeout(8_000),
			},
		);
		if (!detailResponse.ok) {
			throw new Error(`Asset lookup returned HTTP ${detailResponse.status}`);
		}
		const detail = detailSchema.parse(await detailResponse.json());
		const assetResponse = await fetch(detail.url, {
			headers: {
				"User-Agent":
					"FiveCut/0.1 (+https://github.com/5ivesaw/FiveCut)",
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (!assetResponse.ok || !assetResponse.body) {
			throw new Error(`Asset host returned HTTP ${assetResponse.status}`);
		}

		const contentType =
			assetResponse.headers.get("content-type") || "application/octet-stream";
		if (!contentType.startsWith("image/")) {
			throw new Error("The selected result is not a supported image");
		}
		const contentLength = Number(
			assetResponse.headers.get("content-length") || "0",
		);
		if (contentLength > 100 * 1024 * 1024) {
			return NextResponse.json({ error: "Asset exceeds 100 MB" }, { status: 413 });
		}

		return new NextResponse(assetResponse.body, {
			headers: {
				"Content-Type": contentType,
				"Cache-Control": "private, max-age=3600",
				"X-FiveCut-Asset-Name": encodeURIComponent(
					detail.title?.trim() || "open-media-asset",
				),
			},
		});
	} catch (error) {
		console.error("Failed to download open media asset", error);
		return NextResponse.json(
			{ error: "The source asset could not be downloaded" },
			{ status: 502 },
		);
	}
}

export const runtime = "nodejs";
