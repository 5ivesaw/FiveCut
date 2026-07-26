"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	MagicWand05Icon,
	RefreshIcon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import {
	canElementHaveAudio,
	isVisualElement,
	type VisualElement,
} from "@/lib/timeline";
import { DEFAULTS } from "@/lib/timeline/defaults";

const GRADES = [
	{
		type: "color-grade",
		name: "Manual grade",
		description: "Neutral controls",
		style: "linear-gradient(135deg, #334155, #cbd5e1)",
	},
	{
		type: "cinematic-warm",
		name: "Cinematic warm",
		description: "Warm, restrained film look",
		style: "linear-gradient(135deg, #431407, #fb923c, #1c1917)",
	},
	{
		type: "creator-pop",
		name: "Creator pop",
		description: "Bright social-video color",
		style: "linear-gradient(135deg, #0369a1, #f97316, #facc15)",
	},
	{
		type: "cool-clean",
		name: "Cool clean",
		description: "Crisp technology look",
		style: "linear-gradient(135deg, #020617, #0ea5e9, #e0f2fe)",
	},
	{
		type: "noir",
		name: "Noir",
		description: "High-contrast monochrome",
		style: "linear-gradient(135deg, #000, #fafafa, #27272a)",
	},
] as const;

export function AdjustmentsView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const selected = useMemo(
		() => editor.timeline.getElementsWithTracks({ elements: selectedElements }),
		[editor, selectedElements],
	);
	const visualRefs = selected
		.filter(
			(item): item is typeof item & { element: VisualElement } =>
				isVisualElement(item.element),
		)
		.map(({ track, element }) => ({
			trackId: track.id,
			elementId: element.id,
		}));

	const applyEffect = ({ type, name }: { type: string; name: string }) => {
		if (visualRefs.length === 0) {
			toast.info("Select a video, image, text, or graphic clip first");
			return;
		}
		editor.timeline.addClipEffects({ elements: visualRefs, effectType: type });
		toast.success(`${name} applied`, {
			description: `${visualRefs.length} clip${visualRefs.length === 1 ? "" : "s"} · tune it in Properties · one-step undo`,
		});
	};

	const resetVisuals = () => {
		const updates = selected.flatMap(({ track, element }) =>
			isVisualElement(element)
				? [
						{
							trackId: track.id,
							elementId: element.id,
							patch: {
								opacity: DEFAULTS.element.opacity,
								transform: {
									...DEFAULTS.element.transform,
									position: { ...DEFAULTS.element.transform.position },
								},
							},
						},
					]
				: [],
		);
		if (updates.length === 0) {
			toast.info("Select one or more visual clips first");
			return;
		}
		editor.timeline.updateElements({ updates });
		toast.success("Transform and opacity reset");
	};

	const resetAudio = () => {
		const updates = selected.flatMap(({ track, element }) =>
			canElementHaveAudio(element)
				? [
						{
							trackId: track.id,
							elementId: element.id,
							patch: { volume: 0, muted: false },
						},
					]
				: [],
		);
		if (updates.length === 0) {
			toast.info("Select a clip with audio first");
			return;
		}
		editor.timeline.updateElements({ updates });
		toast.success("Audio reset to 0 dB");
	};

	return (
		<PanelView title="Adjustments" contentClassName="pb-4">
			<div className="space-y-5">
				<section>
					<div className="mb-2 flex items-center justify-between">
						<p className="text-muted-foreground text-xs">Color presets</p>
						<span className="text-muted-foreground text-[0.65rem]">
							{visualRefs.length} selected
						</span>
					</div>
					<div className="grid grid-cols-2 gap-2">
						{GRADES.map((grade) => (
							<button
								key={grade.type}
								type="button"
								className="bg-card hover:border-primary/60 overflow-hidden rounded-md border text-left transition-colors"
								onClick={() => applyEffect(grade)}
							>
								<div
									className="h-14"
									style={{ backgroundImage: grade.style }}
								/>
								<div className="p-2">
									<p className="text-xs font-medium">{grade.name}</p>
									<p className="text-muted-foreground text-[0.65rem]">
										{grade.description}
									</p>
								</div>
							</button>
						))}
					</div>
				</section>

				<section>
					<p className="text-muted-foreground mb-2 text-xs">Quick fixes</p>
					<div className="grid gap-2">
						<Button
							variant="outline"
							className="justify-start"
							onClick={() => applyEffect({ type: "sharpen", name: "Sharpen" })}
						>
							<HugeiconsIcon icon={MagicWand05Icon} className="mr-2 size-4" />
							Sharpen selected clips
						</Button>
						<Button
							variant="outline"
							className="justify-start"
							onClick={resetVisuals}
						>
							<HugeiconsIcon icon={RefreshIcon} className="mr-2 size-4" />
							Reset transform and opacity
						</Button>
						<Button
							variant="outline"
							className="justify-start"
							onClick={resetAudio}
						>
							<HugeiconsIcon icon={VolumeHighIcon} className="mr-2 size-4" />
							Reset selected audio to 0 dB
						</Button>
					</div>
				</section>

				<p className="text-muted-foreground text-[0.67rem] leading-relaxed">
					Adjustments are non-destructive. Select the clip afterward and use the
					Properties panel for precise controls and keyframes.
				</p>
			</div>
		</PanelView>
	);
}
