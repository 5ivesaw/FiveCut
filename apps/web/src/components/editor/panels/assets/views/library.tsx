"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Download04Icon,
	Image02Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor } from "@/hooks/use-editor";
import { processMediaAssets } from "@/lib/media/processing";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/lib/timeline/creation";

type LibraryAsset = {
	id: string;
	name: string;
	creator: string;
	license: string;
	attribution: string;
	sourceUrl: string;
	thumbnailUrl: string;
	downloadUrl: string;
	width: number;
	height: number;
	filesize?: number;
	filetype: string;
};

type LibraryResponse = {
	results: LibraryAsset[];
	source: "openverse" | "fivecut-offline";
	offlineFallback?: boolean;
};

const SUGGESTIONS = [
	"abstract",
	"nature",
	"technology",
	"paper texture",
	"cinematic",
];

export function LibraryView() {
	const editor = useEditor();
	const activeProject = useEditor((core) => core.project.getActive());
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<LibraryAsset[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isAdding, setIsAdding] = useState<string | null>(null);
	const [source, setSource] =
		useState<LibraryResponse["source"]>("fivecut-offline");

	useEffect(() => {
		const controller = new AbortController();
		const timer = window.setTimeout(async () => {
			setIsLoading(true);
			try {
				const params = new URLSearchParams({
					page_size: "20",
					commercial_only: "true",
				});
				if (query.trim()) params.set("q", query.trim());
				const response = await fetch(`/api/library/search?${params.toString()}`, {
					signal: controller.signal,
				});
				if (!response.ok) {
					throw new Error(`Search returned HTTP ${response.status}`);
				}
				const data = (await response.json()) as LibraryResponse;
				setResults(data.results);
				setSource(data.source);
			} catch (error) {
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					console.error("Asset library search failed", error);
					toast.error("Could not search the online asset library");
				}
			} finally {
				if (!controller.signal.aborted) setIsLoading(false);
			}
		}, query ? 350 : 0);

		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [query]);

	const status = useMemo(
		() =>
			source === "openverse"
				? "Openly licensed results · downloaded items are cached offline"
				: "Built-in offline collection",
		[source],
	);

	const addAsset = async (asset: LibraryAsset) => {
		if (!activeProject || isAdding) return;
		setIsAdding(asset.id);
		try {
			const response = await fetch(asset.downloadUrl);
			if (!response.ok) {
				throw new Error(`Download returned HTTP ${response.status}`);
			}
			const blob = await response.blob();
			const extension =
				asset.filetype.replaceAll(/[^a-zA-Z0-9]+/g, "") ||
				blob.type.split("/")[1] ||
				"png";
			const safeName =
				asset.name.replaceAll(/[^a-zA-Z0-9._ -]+/g, "").trim() || "asset";
			const file = new File([blob], `${safeName}.${extension}`, {
				type: blob.type || "image/png",
			});
			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed) throw new Error("FiveCut could not decode this image");
			const saved = await editor.media.addMediaAsset({
				projectId: activeProject.metadata.id,
				asset: processed,
			});
			if (!saved) throw new Error("FiveCut could not cache this image");

			editor.timeline.insertElement({
				element: buildElementFromMedia({
					mediaId: saved.id,
					mediaType: "image",
					name: saved.name,
					duration: DEFAULT_NEW_ELEMENT_DURATION,
					startTime: editor.playback.getCurrentTime(),
				}),
				placement: { mode: "auto" },
			});
			toast.success("Asset added and cached", {
				description: `${asset.name} is now available offline in this project.`,
			});
		} catch (error) {
			toast.error("Could not add asset", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsAdding(null);
		}
	};

	return (
		<PanelView
			title="Creator library"
			contentClassName="pb-4"
			actions={
				<span className="text-muted-foreground hidden text-[0.65rem] xl:inline">
					CC / public domain
				</span>
			}
		>
			<div className="space-y-3">
				<div className="relative">
					<HugeiconsIcon
						icon={Search01Icon}
						className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
					/>
					<Input
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
						placeholder="Search photos and backgrounds"
						className="pl-9"
						showClearIcon
						onClear={() => setQuery("")}
					/>
				</div>
				<div className="scrollbar-hidden flex gap-1.5 overflow-x-auto">
					{SUGGESTIONS.map((suggestion) => (
						<Button
							key={suggestion}
							variant="outline"
							size="sm"
							className="h-7 shrink-0 rounded-full px-2.5 text-xs"
							onClick={() => setQuery(suggestion)}
						>
							{suggestion}
						</Button>
					))}
				</div>
				<p className="text-muted-foreground text-[0.67rem] leading-relaxed">
					{status}. Check the shown license before publishing; FiveCut keeps
					attribution with the catalog result.
				</p>

				{isLoading ? (
					<div className="text-muted-foreground flex h-36 items-center justify-center text-sm">
						Searching the creator library…
					</div>
				) : results.length === 0 ? (
					<div className="text-muted-foreground flex h-36 flex-col items-center justify-center gap-2 text-sm">
						<HugeiconsIcon icon={Image02Icon} className="size-8" />
						No matching assets
					</div>
				) : (
					<div className="grid grid-cols-2 gap-2">
						{results.map((asset) => (
							<article
								key={asset.id}
								className="group bg-card overflow-hidden rounded-md border"
								title={asset.attribution}
							>
								<div
									className="bg-accent aspect-video bg-cover bg-center"
									style={{ backgroundImage: `url("${asset.thumbnailUrl}")` }}
									role="img"
									aria-label={asset.name}
								/>
								<div className="space-y-1 p-2">
									<p className="truncate text-xs font-medium">{asset.name}</p>
									<p className="text-muted-foreground truncate text-[0.65rem]">
										{asset.creator} · {asset.license}
									</p>
									<Button
										size="sm"
										className="mt-1 h-7 w-full text-xs"
										disabled={isAdding !== null}
										onClick={() => addAsset(asset)}
									>
										<HugeiconsIcon
											icon={Download04Icon}
											className="mr-1 size-3.5"
										/>
										{isAdding === asset.id ? "Adding…" : "Add to timeline"}
									</Button>
								</div>
							</article>
						))}
					</div>
				)}
			</div>
		</PanelView>
	);
}
