"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import type {
	AnimationPath,
	AnimationValue,
} from "@/lib/animation/types";
import { isVisualElement, type VisualElement } from "@/lib/timeline";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { cn } from "@/utils/ui";

type TransitionKey = {
	path: AnimationPath;
	at: "start" | "in" | "out" | "end" | "punch";
	value: ({
		element,
		canvasWidth,
	}: {
		element: VisualElement;
		canvasWidth: number;
	}) => AnimationValue;
};

type TransitionPreset = {
	id: string;
	name: string;
	description: string;
	swatch: string;
	keys: TransitionKey[];
};

const opacity = (element: VisualElement) => element.opacity;
const x = (element: VisualElement) => element.transform.position.x;

const PRESETS: TransitionPreset[] = [
	{
		id: "fade-in",
		name: "Fade in",
		description: "Clean entrance",
		swatch: "from-transparent to-white/80",
		keys: [
			{ path: "opacity", at: "start", value: () => 0 },
			{ path: "opacity", at: "in", value: ({ element }) => opacity(element) },
		],
	},
	{
		id: "fade-out",
		name: "Fade out",
		description: "Clean exit",
		swatch: "from-white/80 to-transparent",
		keys: [
			{ path: "opacity", at: "out", value: ({ element }) => opacity(element) },
			{ path: "opacity", at: "end", value: () => 0 },
		],
	},
	{
		id: "fade-both",
		name: "Soft dissolve",
		description: "Entrance and exit",
		swatch: "from-transparent via-white/80 to-transparent",
		keys: [
			{ path: "opacity", at: "start", value: () => 0 },
			{ path: "opacity", at: "in", value: ({ element }) => opacity(element) },
			{ path: "opacity", at: "out", value: ({ element }) => opacity(element) },
			{ path: "opacity", at: "end", value: () => 0 },
		],
	},
	{
		id: "slide-left",
		name: "Slide left",
		description: "Fast creator entrance",
		swatch: "from-primary/80 to-white/80",
		keys: [
			{
				path: "transform.positionX",
				at: "start",
				value: ({ element, canvasWidth }) => x(element) + canvasWidth * 0.3,
			},
			{
				path: "transform.positionX",
				at: "in",
				value: ({ element }) => x(element),
			},
			{ path: "opacity", at: "start", value: () => 0.15 },
			{ path: "opacity", at: "in", value: ({ element }) => opacity(element) },
		],
	},
	{
		id: "slide-right",
		name: "Slide right",
		description: "Reverse entrance",
		swatch: "from-white/80 to-primary/80",
		keys: [
			{
				path: "transform.positionX",
				at: "start",
				value: ({ element, canvasWidth }) => x(element) - canvasWidth * 0.3,
			},
			{
				path: "transform.positionX",
				at: "in",
				value: ({ element }) => x(element),
			},
			{ path: "opacity", at: "start", value: () => 0.15 },
			{ path: "opacity", at: "in", value: ({ element }) => opacity(element) },
		],
	},
	{
		id: "zoom-in",
		name: "Zoom in",
		description: "Smooth reveal",
		swatch: "from-primary/30 to-primary",
		keys: [
			{
				path: "transform.scaleX",
				at: "start",
				value: ({ element }) => element.transform.scaleX * 0.78,
			},
			{
				path: "transform.scaleY",
				at: "start",
				value: ({ element }) => element.transform.scaleY * 0.78,
			},
			{
				path: "transform.scaleX",
				at: "in",
				value: ({ element }) => element.transform.scaleX,
			},
			{
				path: "transform.scaleY",
				at: "in",
				value: ({ element }) => element.transform.scaleY,
			},
			{ path: "opacity", at: "start", value: () => 0 },
			{ path: "opacity", at: "in", value: ({ element }) => opacity(element) },
		],
	},
	{
		id: "zoom-out",
		name: "Zoom out",
		description: "Dramatic exit",
		swatch: "from-primary to-primary/20",
		keys: [
			{
				path: "transform.scaleX",
				at: "out",
				value: ({ element }) => element.transform.scaleX,
			},
			{
				path: "transform.scaleY",
				at: "out",
				value: ({ element }) => element.transform.scaleY,
			},
			{
				path: "transform.scaleX",
				at: "end",
				value: ({ element }) => element.transform.scaleX * 1.18,
			},
			{
				path: "transform.scaleY",
				at: "end",
				value: ({ element }) => element.transform.scaleY * 1.18,
			},
			{ path: "opacity", at: "out", value: ({ element }) => opacity(element) },
			{ path: "opacity", at: "end", value: () => 0 },
		],
	},
	{
		id: "punch",
		name: "Punch",
		description: "Quick emphasis",
		swatch: "from-primary via-yellow-300 to-primary",
		keys: [
			{
				path: "transform.scaleX",
				at: "start",
				value: ({ element }) => element.transform.scaleX,
			},
			{
				path: "transform.scaleY",
				at: "start",
				value: ({ element }) => element.transform.scaleY,
			},
			{
				path: "transform.scaleX",
				at: "punch",
				value: ({ element }) => element.transform.scaleX * 1.09,
			},
			{
				path: "transform.scaleY",
				at: "punch",
				value: ({ element }) => element.transform.scaleY * 1.09,
			},
			{
				path: "transform.scaleX",
				at: "in",
				value: ({ element }) => element.transform.scaleX,
			},
			{
				path: "transform.scaleY",
				at: "in",
				value: ({ element }) => element.transform.scaleY,
			},
		],
	},
];

const DURATIONS = [0.25, 0.5, 0.75, 1] as const;

export function TransitionsView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const [seconds, setSeconds] = useState<(typeof DURATIONS)[number]>(0.5);
	const selectedVisuals = useMemo(
		() =>
			editor.timeline
				.getElementsWithTracks({ elements: selectedElements })
				.filter(
					(item): item is typeof item & { element: VisualElement } =>
						isVisualElement(item.element),
				),
		[editor, selectedElements],
	);

	const applyPreset = (preset: TransitionPreset) => {
		if (selectedVisuals.length === 0) {
			toast.info("Select one or more visual clips first");
			return;
		}
		const canvasWidth = editor.project.getActive().settings.canvasSize.width;
		const requestedDuration = Math.round(seconds * TICKS_PER_SECOND);
		const keyframes = selectedVisuals.flatMap(({ track, element }) => {
			const duration = Math.min(
				requestedDuration,
				Math.max(1, Math.floor(element.duration / 2)),
			);
			const timeByPosition = {
				start: 0,
				in: duration,
				out: Math.max(0, element.duration - duration),
				end: element.duration,
				punch: Math.round(duration * 0.45),
			};
			return preset.keys.map((key) => ({
				trackId: track.id,
				elementId: element.id,
				propertyPath: key.path,
				time: timeByPosition[key.at],
				value: key.value({ element, canvasWidth }),
				interpolation: "bezier" as const,
			}));
		});
		editor.timeline.upsertKeyframes({ keyframes });
		toast.success(`${preset.name} applied`, {
			description: `${selectedVisuals.length} clip${selectedVisuals.length === 1 ? "" : "s"} · one-step undo`,
		});
	};

	return (
		<PanelView title="Transitions" contentClassName="pb-4">
			<div className="space-y-4">
				<div>
					<p className="text-muted-foreground mb-2 text-xs">Duration</p>
					<div className="grid grid-cols-4 gap-1">
						{DURATIONS.map((duration) => (
							<Button
								key={duration}
								size="sm"
								variant={seconds === duration ? "secondary" : "outline"}
								className="h-7 px-1 text-xs"
								onClick={() => setSeconds(duration)}
							>
								{duration}s
							</Button>
						))}
					</div>
				</div>
				<div className="grid grid-cols-2 gap-2">
					{PRESETS.map((preset) => (
						<button
							key={preset.id}
							type="button"
							className="bg-card hover:border-primary/60 overflow-hidden rounded-md border text-left transition-colors"
							onClick={() => applyPreset(preset)}
						>
							<div
								className={cn(
									"h-14 bg-linear-to-r opacity-80",
									preset.swatch,
								)}
							/>
							<div className="p-2">
								<p className="text-xs font-medium">{preset.name}</p>
								<p className="text-muted-foreground text-[0.65rem]">
									{preset.description}
								</p>
							</div>
						</button>
					))}
				</div>
				<p className="text-muted-foreground text-[0.67rem] leading-relaxed">
					Presets create editable keyframes and are grouped into one undo
					operation. Existing clip keyframes outside the preset times stay intact.
				</p>
			</div>
		</PanelView>
	);
}
