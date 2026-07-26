"use client";

import type { FrameRate } from "opencut-wasm";
import { upsertPathKeyframe } from "@/lib/animation";
import { resolveAnimationTarget } from "@/lib/animation/target-resolver";
import type {
	AnimationInterpolation,
	AnimationPath,
	AnimationValue,
} from "@/lib/animation/types";
import {
	buildDefaultEffectInstance,
	registerDefaultEffects,
} from "@/lib/effects";
import type { Effect } from "@/lib/effects/types";
import type { MediaAsset } from "@/lib/media/types";
import { processMediaAssets } from "@/lib/media/processing";
import type { TProject } from "@/lib/project/types";
import type {
	AudioElement,
	AudioTrack,
	EffectTrack,
	GraphicElement,
	GraphicTrack,
	ImageElement,
	SceneTracks,
	TextElement,
	TextTrack,
	TimelineElement,
	TimelineTrack,
	VideoElement,
	VideoTrack,
} from "@/lib/timeline";
import { DEFAULTS } from "@/lib/timeline/defaults";
import { FONT_SIZE_SCALE_REFERENCE } from "@/lib/text/typography";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import {
	type FiveCutClip,
	type FiveCutProjectDocument,
	fiveCutProjectSchema,
} from "./project-schema";

const SUPPORTED_CAPABILITIES = new Set([
	"asset-index-v1",
	"transactional-commands-v1",
	"ffmpeg-render-v1",
	"captions-v1",
	"keyframes-v1",
	"color-grade-v1",
	"freeze-frame-v1",
]);

export class FiveCutImportError extends Error {
	constructor(
		message: string,
		readonly details: string[] = [],
	) {
		super(message);
		this.name = "FiveCutImportError";
	}
}

export interface FiveCutImportResult {
	document: FiveCutProjectDocument;
	project: TProject;
	mediaAssets: MediaAsset[];
	warnings: string[];
}

function toTicks(seconds: number): number {
	return Math.round(seconds * TICKS_PER_SECOND);
}

function normalizePath(value: string): string {
	return value
		.replaceAll("\\", "/")
		.replace(/^\.\/+/, "")
		.replace(/^\/+/, "")
		.replace(/\/+/g, "/");
}

function pathsForFile(file: File): string[] {
	const relative = normalizePath(
		(file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "",
	);
	const candidates = new Set([normalizePath(file.name)]);
	if (relative) {
		candidates.add(relative);
		const segments = relative.split("/");
		if (segments.length > 1) {
			candidates.add(segments.slice(1).join("/"));
		}
	}
	return [...candidates];
}

function findAssetFile({
	path,
	files,
}: {
	path: string;
	files: File[];
}): File | null {
	const normalized = normalizePath(path);
	const exact = files.filter((file) => pathsForFile(file).includes(normalized));
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) {
		throw new FiveCutImportError(
			`More than one selected file matches ${path}.`,
		);
	}
	const suffix = files.filter((file) =>
		pathsForFile(file).some(
			(candidate) =>
				candidate === normalized || candidate.endsWith(`/${normalized}`),
		),
	);
	if (suffix.length === 1) return suffix[0];
	const basename = normalized.split("/").at(-1);
	const byName = files.filter((file) => file.name === basename);
	return byName.length === 1 ? byName[0] : null;
}

async function sha256(file: File): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await file.arrayBuffer(),
	);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

function importTransform(
	clip: FiveCutClip,
): VideoElement["transform"] | ImageElement["transform"] {
	return {
		scaleX: clip.transform?.scaleX ?? DEFAULTS.element.transform.scaleX,
		scaleY: clip.transform?.scaleY ?? DEFAULTS.element.transform.scaleY,
		position: {
			x: clip.transform?.positionX ?? DEFAULTS.element.transform.position.x,
			y: clip.transform?.positionY ?? DEFAULTS.element.transform.position.y,
		},
		rotate: clip.transform?.rotation ?? DEFAULTS.element.transform.rotate,
	};
}

function importEffects(clip: FiveCutClip): Effect[] {
	registerDefaultEffects();
	return (clip.effects ?? []).map((source) => {
		const type = source.type;
		const params: Record<string, number | string | boolean> = {
			...(source.params ?? {}),
		};
		if (type === "blur") {
			params.intensity =
				typeof params.intensity === "number"
					? params.intensity
					: Number(params.sigma ?? 3) * 5;
			delete params.sigma;
		}
		if (type === "pixelate" && params.size !== undefined) {
			params.pixelSize = params.size;
			delete params.size;
		}
		if (type === "film-grain" && typeof params.amount === "number") {
			params.intensity =
				params.amount > 1 ? params.amount / 100 : params.amount;
			delete params.amount;
		}
		const defaults = buildDefaultEffectInstance({ effectType: type });
		return {
			...defaults,
			id: source.id,
			type,
			enabled: source.enabled ?? true,
			params: { ...defaults.params, ...params },
		};
	});
}

function withKeyframe({
	element,
	propertyPath,
	time,
	value,
	interpolation,
	id,
}: {
	element: TimelineElement;
	propertyPath: AnimationPath;
	time: number;
	value: AnimationValue;
	interpolation: AnimationInterpolation;
	id: string;
}): TimelineElement {
	const target = resolveAnimationTarget({ element, path: propertyPath });
	if (!target) {
		throw new FiveCutImportError(
			`Keyframe ${id} cannot animate ${propertyPath} on a ${element.type} clip.`,
		);
	}
	return {
		...element,
		animations: upsertPathKeyframe({
			animations: element.animations,
			propertyPath,
			time,
			value,
			interpolation,
			keyframeId: id,
			kind: target.kind,
			defaultInterpolation: target.defaultInterpolation,
			coerceValue: target.coerceValue,
		}),
	};
}

function keyframeInterpolation(
	value: NonNullable<FiveCutClip["keyframes"]>[number]["interpolation"],
): AnimationInterpolation {
	if (value === "hold") return "hold";
	if (value === "ease-in" || value === "ease-out" || value === "ease-in-out") {
		return "bezier";
	}
	return "linear";
}

function applyTransitions({
	element,
	clip,
	canvasWidth,
}: {
	element: TimelineElement;
	clip: FiveCutClip;
	canvasWidth: number;
}): TimelineElement {
	let result = element;
	const duration = toTicks(clip.duration);
	const transform =
		"transform" in element ? element.transform : DEFAULTS.element.transform;
	const opacity = "opacity" in element ? element.opacity : 1;
	const volume = "volume" in element ? (element.volume ?? 0) : 0;
	const transitionIn = clip.transitionIn;
	if (
		transitionIn &&
		transitionIn.type !== "none" &&
		transitionIn.duration > 0
	) {
		const end = toTicks(transitionIn.duration);
		if (transitionIn.type === "fade" || transitionIn.type === "dissolve") {
			result = withKeyframe({
				element: result,
				propertyPath: element.type === "audio" ? "volume" : "opacity",
				time: 0,
				value: element.type === "audio" ? -96 : 0,
				interpolation: "linear",
				id: `${clip.id}:transition-in:start`,
			});
			result = withKeyframe({
				element: result,
				propertyPath: element.type === "audio" ? "volume" : "opacity",
				time: end,
				value: element.type === "audio" ? volume : opacity,
				interpolation: "linear",
				id: `${clip.id}:transition-in:end`,
			});
		} else if (
			transitionIn.type === "slide-left" ||
			transitionIn.type === "slide-right"
		) {
			if (element.type === "audio") {
				throw new FiveCutImportError(
					`Audio clip ${clip.id} cannot use a slide transition.`,
				);
			}
			result = withKeyframe({
				element: result,
				propertyPath: "transform.positionX",
				time: 0,
				value:
					transform.position.x +
					(transitionIn.type === "slide-left" ? canvasWidth : -canvasWidth),
				interpolation: "bezier",
				id: `${clip.id}:transition-in:start`,
			});
			result = withKeyframe({
				element: result,
				propertyPath: "transform.positionX",
				time: end,
				value: transform.position.x,
				interpolation: "bezier",
				id: `${clip.id}:transition-in:end`,
			});
		} else if (transitionIn.type === "zoom") {
			if (element.type === "audio") {
				throw new FiveCutImportError(
					`Audio clip ${clip.id} cannot use a zoom transition.`,
				);
			}
			for (const axis of ["scaleX", "scaleY"] as const) {
				result = withKeyframe({
					element: result,
					propertyPath: `transform.${axis}`,
					time: 0,
					value: transform[axis] * 0.82,
					interpolation: "bezier",
					id: `${clip.id}:transition-in:${axis}:start`,
				});
				result = withKeyframe({
					element: result,
					propertyPath: `transform.${axis}`,
					time: end,
					value: transform[axis],
					interpolation: "bezier",
					id: `${clip.id}:transition-in:${axis}:end`,
				});
			}
		}
	}
	const transitionOut = clip.transitionOut;
	if (
		transitionOut &&
		transitionOut.type !== "none" &&
		transitionOut.duration > 0
	) {
		const start = Math.max(0, duration - toTicks(transitionOut.duration));
		if (transitionOut.type === "fade" || transitionOut.type === "dissolve") {
			result = withKeyframe({
				element: result,
				propertyPath: element.type === "audio" ? "volume" : "opacity",
				time: start,
				value: element.type === "audio" ? volume : opacity,
				interpolation: "linear",
				id: `${clip.id}:transition-out:start`,
			});
			result = withKeyframe({
				element: result,
				propertyPath: element.type === "audio" ? "volume" : "opacity",
				time: duration,
				value: element.type === "audio" ? -96 : 0,
				interpolation: "linear",
				id: `${clip.id}:transition-out:end`,
			});
		} else if (
			transitionOut.type === "slide-left" ||
			transitionOut.type === "slide-right"
		) {
			if (element.type === "audio") {
				throw new FiveCutImportError(
					`Audio clip ${clip.id} cannot use a slide transition.`,
				);
			}
			result = withKeyframe({
				element: result,
				propertyPath: "transform.positionX",
				time: start,
				value: transform.position.x,
				interpolation: "bezier",
				id: `${clip.id}:transition-out:start`,
			});
			result = withKeyframe({
				element: result,
				propertyPath: "transform.positionX",
				time: duration,
				value:
					transform.position.x +
					(transitionOut.type === "slide-left" ? -canvasWidth : canvasWidth),
				interpolation: "bezier",
				id: `${clip.id}:transition-out:end`,
			});
		} else if (transitionOut.type === "zoom") {
			if (element.type === "audio") {
				throw new FiveCutImportError(
					`Audio clip ${clip.id} cannot use a zoom transition.`,
				);
			}
			for (const axis of ["scaleX", "scaleY"] as const) {
				result = withKeyframe({
					element: result,
					propertyPath: `transform.${axis}`,
					time: start,
					value: transform[axis],
					interpolation: "bezier",
					id: `${clip.id}:transition-out:${axis}:start`,
				});
				result = withKeyframe({
					element: result,
					propertyPath: `transform.${axis}`,
					time: duration,
					value: transform[axis] * 0.82,
					interpolation: "bezier",
					id: `${clip.id}:transition-out:${axis}:end`,
				});
			}
		}
	}
	return result;
}

function applyProjectKeyframes({
	element,
	clip,
}: {
	element: TimelineElement;
	clip: FiveCutClip;
}): TimelineElement {
	let result = element;
	const propertyMap: Record<string, AnimationPath> = {
		opacity: "opacity",
		volumeDb: "volume",
		"transform.positionX": "transform.positionX",
		"transform.positionY": "transform.positionY",
		"transform.scaleX": "transform.scaleX",
		"transform.scaleY": "transform.scaleY",
		"transform.rotation": "transform.rotate",
	};
	for (const keyframe of clip.keyframes ?? []) {
		result = withKeyframe({
			element: result,
			propertyPath: propertyMap[keyframe.property],
			time: toTicks(keyframe.time),
			value: keyframe.value,
			interpolation: keyframeInterpolation(keyframe.interpolation),
			id: keyframe.id,
		});
	}
	return result;
}

function textPosition({
	clip,
	canvasWidth,
	canvasHeight,
}: {
	clip: FiveCutClip;
	canvasWidth: number;
	canvasHeight: number;
}): { x: number; y: number } {
	const style = clip.style;
	const fontSize = style?.fontSize ?? 64;
	const marginX = style?.marginX ?? 60;
	const marginY = style?.marginY ?? 80;
	const x =
		style?.alignment === "left"
			? -canvasWidth / 2 + marginX
			: style?.alignment === "right"
				? canvasWidth / 2 - marginX
				: 0;
	const y = {
		top: -canvasHeight / 2 + marginY + fontSize / 2,
		"upper-third": -canvasHeight / 4,
		center: 0,
		"lower-third": canvasHeight / 4,
		bottom: canvasHeight / 2 - marginY - fontSize / 2,
	}[style?.position ?? "bottom"];
	return {
		x: x + (clip.transform?.positionX ?? 0),
		y: y + (clip.transform?.positionY ?? 0),
	};
}

function buildElement({
	clip,
	trackKind,
	assetMap,
	canvasWidth,
	canvasHeight,
}: {
	clip: FiveCutClip;
	trackKind: FiveCutProjectDocument["tracks"][number]["kind"];
	assetMap: Map<string, MediaAsset>;
	canvasWidth: number;
	canvasHeight: number;
}): TimelineElement {
	const base = {
		id: clip.id,
		name: clip.name ?? clip.text?.slice(0, 80) ?? clip.id,
		duration: toTicks(clip.duration),
		startTime: toTicks(clip.start),
		trimStart: 0,
		trimEnd: 0,
	};
	let element: TimelineElement;
	if (clip.type === "media") {
		const asset = assetMap.get(String(clip.assetId));
		if (!asset) {
			throw new FiveCutImportError(
				`Clip ${clip.id} references missing asset ${clip.assetId}.`,
			);
		}
		const sourceDuration =
			asset.duration ?? clip.sourceDuration ?? clip.duration;
		const trimStart = clip.sourceIn ?? 0;
		const selectedSourceDuration =
			clip.sourceDuration ?? clip.duration * (clip.speed ?? 1);
		const trimEnd = Math.max(
			0,
			sourceDuration - trimStart - selectedSourceDuration,
		);
		if (
			clip.freezeFrameSourceTime !== undefined &&
			asset.type !== "video"
		) {
			throw new FiveCutImportError(
				`Clip ${clip.id} can only freeze a video asset.`,
			);
		}
		if (
			clip.freezeFrameSourceTime !== undefined &&
			clip.freezeFrameSourceTime >= sourceDuration
		) {
			throw new FiveCutImportError(
				`Clip ${clip.id} freezes beyond the end of ${asset.name}.`,
			);
		}
		if (asset.type === "video" && trackKind !== "audio") {
			const isFreezeFrame = clip.freezeFrameSourceTime !== undefined;
			element = {
				...base,
				type: "video",
				mediaId: asset.id,
				sourceDuration: isFreezeFrame ? undefined : toTicks(sourceDuration),
				trimStart: isFreezeFrame ? 0 : toTicks(trimStart),
				trimEnd: isFreezeFrame ? 0 : toTicks(trimEnd),
				freezeFrameSourceTime: isFreezeFrame
					? toTicks(clip.freezeFrameSourceTime ?? 0)
					: undefined,
				volume: isFreezeFrame
					? 0
					: (clip.volumeDb ?? DEFAULTS.element.volume),
				muted: isFreezeFrame ? true : (clip.muted ?? false),
				isSourceAudioEnabled: isFreezeFrame
					? false
					: (clip.includeSourceAudio ?? true),
				hidden: false,
				retime:
					!isFreezeFrame && clip.speed && clip.speed !== 1
						? { rate: clip.speed, maintainPitch: true }
						: undefined,
				transform: importTransform(clip),
				opacity: clip.opacity ?? DEFAULTS.element.opacity,
				blendMode: DEFAULTS.element.blendMode,
				effects: importEffects(clip),
			} satisfies VideoElement;
		} else if (asset.type === "image") {
			if (trackKind === "audio") {
				throw new FiveCutImportError(
					`Image asset ${asset.id} cannot be placed on audio track ${trackKind}.`,
				);
			}
			element = {
				...base,
				type: "image",
				mediaId: asset.id,
				hidden: false,
				transform: importTransform(clip),
				opacity: clip.opacity ?? DEFAULTS.element.opacity,
				blendMode: DEFAULTS.element.blendMode,
				effects: importEffects(clip),
			} satisfies ImageElement;
		} else {
			if (trackKind !== "audio") {
				throw new FiveCutImportError(
					`Audio asset ${asset.id} must be placed on an audio track.`,
				);
			}
			element = {
				...base,
				type: "audio",
				sourceType: "upload",
				mediaId: asset.id,
				sourceDuration: toTicks(sourceDuration),
				trimStart: toTicks(trimStart),
				trimEnd: toTicks(trimEnd),
				volume: clip.volumeDb ?? DEFAULTS.element.volume,
				muted: clip.muted ?? false,
				retime:
					clip.speed && clip.speed !== 1
						? { rate: clip.speed, maintainPitch: true }
						: undefined,
			} satisfies AudioElement;
		}
	} else if (clip.type === "text" || clip.type === "caption") {
		if (clip.style?.fontFileAssetId) {
			throw new FiveCutImportError(
				`Clip ${clip.id} uses custom font asset ${clip.style.fontFileAssetId}. ` +
					"Desktop project import currently requires an installed fontFamily.",
			);
		}
		const position = textPosition({ clip, canvasWidth, canvasHeight });
		const fontSizePixels = clip.style?.fontSize ?? 64;
		element = {
			...base,
			type: "text",
			content: clip.text ?? "",
			fontSize: (fontSizePixels * FONT_SIZE_SCALE_REFERENCE) / canvasHeight,
			fontFamily: clip.style?.fontFamily ?? "Arial",
			color: clip.style?.color ?? "#FFFFFF",
			background: {
				enabled: Boolean(clip.style?.backgroundColor),
				color: clip.style?.backgroundColor ?? "transparent",
			},
			textAlign: clip.style?.alignment ?? "center",
			fontWeight: clip.style?.fontWeight ?? "bold",
			fontStyle: clip.style?.fontStyle ?? "normal",
			textDecoration: "none",
			outlineColor: clip.style?.outlineColor ?? "#000000",
			outlineWidth:
				((clip.style?.outlineWidth ?? 0) * FONT_SIZE_SCALE_REFERENCE) /
				canvasHeight,
			transform: {
				...importTransform(clip),
				position,
			},
			opacity: clip.opacity ?? DEFAULTS.element.opacity,
			blendMode: DEFAULTS.element.blendMode,
			effects: importEffects(clip),
		} satisfies TextElement;
	} else {
		const metadata = clip.metadata ?? {};
		element = {
			...base,
			type: "graphic",
			definitionId: "rectangle",
			params: {
				fill: typeof metadata.color === "string" ? metadata.color : "#F97316",
				stroke:
					typeof metadata.stroke === "string" ? metadata.stroke : "#000000",
				strokeWidth:
					typeof metadata.strokeWidth === "number" ? metadata.strokeWidth : 0,
				strokeAlign: "center",
				cornerRadius:
					typeof metadata.cornerRadius === "number" ? metadata.cornerRadius : 0,
			},
			transform: importTransform(clip),
			opacity: clip.opacity ?? DEFAULTS.element.opacity,
			blendMode: DEFAULTS.element.blendMode,
			effects: importEffects(clip),
		} satisfies GraphicElement;
	}
	element = applyTransitions({ element, clip, canvasWidth });
	return applyProjectKeyframes({ element, clip });
}

function appTrackType({
	kind,
	elements,
}: {
	kind: FiveCutProjectDocument["tracks"][number]["kind"];
	elements: TimelineElement[];
}): TimelineTrack["type"] {
	if (kind === "audio") return "audio";
	if (kind === "caption") return "text";
	if (kind === "adjustment") return "effect";
	const types = new Set(elements.map((element) => element.type));
	if ([...types].every((type) => type === "video" || type === "image")) {
		return "video";
	}
	if ([...types].every((type) => type === "text")) return "text";
	if ([...types].every((type) => type === "graphic")) return "graphic";
	throw new FiveCutImportError(
		`Track kind ${kind} mixes element types that FiveCut cannot place on one track.`,
		[...types],
	);
}

function buildTracks({
	document,
	assetMap,
	warnings,
}: {
	document: FiveCutProjectDocument;
	assetMap: Map<string, MediaAsset>;
	warnings: string[];
}): SceneTracks {
	const visualTracks: Array<
		VideoTrack | TextTrack | GraphicTrack | EffectTrack
	> = [];
	const audioTracks: AudioTrack[] = [];
	for (const source of document.tracks) {
		if (source.kind === "adjustment" && source.clips.length > 0) {
			throw new FiveCutImportError(
				`Adjustment track ${source.id} is not importable. Put effects on clips.`,
			);
		}
		if (source.locked) {
			warnings.push(
				`Track ${source.id} was locked in the AI document; lock state is not persisted by this editor version.`,
			);
		}
		const elements = source.clips.map((clip) =>
			buildElement({
				clip,
				trackKind: source.kind,
				assetMap,
				canvasWidth: document.project.canvas.width,
				canvasHeight: document.project.canvas.height,
			}),
		);
		const type = appTrackType({ kind: source.kind, elements });
		if (type === "audio") {
			audioTracks.push({
				id: source.id,
				name: source.name,
				type: "audio",
				elements: elements as AudioElement[],
				muted: source.muted ?? false,
			});
		} else if (type === "video") {
			visualTracks.push({
				id: source.id,
				name: source.name,
				type: "video",
				elements: elements as Array<VideoElement | ImageElement>,
				muted: source.muted ?? false,
				hidden: source.hidden ?? false,
			});
		} else if (type === "text") {
			visualTracks.push({
				id: source.id,
				name: source.name,
				type: "text",
				elements: elements as TextElement[],
				hidden: source.hidden ?? false,
			});
		} else if (type === "graphic") {
			visualTracks.push({
				id: source.id,
				name: source.name,
				type: "graphic",
				elements: elements as GraphicElement[],
				hidden: source.hidden ?? false,
			});
		} else {
			visualTracks.push({
				id: source.id,
				name: source.name,
				type: "effect",
				elements: [],
				hidden: source.hidden ?? false,
			});
		}
	}
	return {
		overlay: visualTracks.reverse(),
		main: {
			id: `${document.project.id}:main`,
			name: "Main Video",
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		},
		audio: audioTracks,
	};
}

function parseDate(value: string | undefined, fallback: Date): Date {
	if (!value) return fallback;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export async function importFiveCutProject({
	rawDocument,
	files,
}: {
	rawDocument: unknown;
	files: File[];
}): Promise<FiveCutImportResult> {
	const parsed = fiveCutProjectSchema.safeParse(rawDocument);
	if (!parsed.success) {
		throw new FiveCutImportError(
			"The AI project JSON is invalid.",
			parsed.error.issues.map(
				(issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
			),
		);
	}
	const document = parsed.data;
	const unsupportedCapabilities = (
		document.compatibility?.requiredCapabilities ?? []
	).filter((capability) => !SUPPORTED_CAPABILITIES.has(capability));
	if (unsupportedCapabilities.length > 0) {
		throw new FiveCutImportError(
			"The project requires unsupported capabilities.",
			unsupportedCapabilities,
		);
	}
	const usedAssetIds = new Set(
		document.tracks.flatMap((track) =>
			track.clips.flatMap((clip) =>
				clip.type === "media" && clip.assetId ? [clip.assetId] : [],
			),
		),
	);
	const mediaAssets: MediaAsset[] = [];
	const warnings: string[] = [];
	for (const sourceAsset of document.assets) {
		if (!["video", "audio", "image"].includes(sourceAsset.kind)) {
			if (usedAssetIds.has(sourceAsset.id)) {
				throw new FiveCutImportError(
					`Asset ${sourceAsset.id} has unsupported media kind ${sourceAsset.kind}.`,
				);
			}
			continue;
		}
		const file = findAssetFile({ path: sourceAsset.path, files });
		if (!file) {
			if (sourceAsset.optional && !usedAssetIds.has(sourceAsset.id)) {
				warnings.push(`Optional asset not selected: ${sourceAsset.path}`);
				continue;
			}
			throw new FiveCutImportError(
				`Required asset was not selected: ${sourceAsset.path}`,
			);
		}
		if (sourceAsset.sha256) {
			const actualHash = await sha256(file);
			if (actualHash !== sourceAsset.sha256) {
				throw new FiveCutImportError(`Hash mismatch for ${sourceAsset.path}.`, [
					`expected ${sourceAsset.sha256}`,
					`actual ${actualHash}`,
				]);
			}
		}
		const [processed] = await processMediaAssets({ files: [file] });
		if (!processed) {
			throw new FiveCutImportError(
				`FiveCut could not decode ${sourceAsset.path}.`,
			);
		}
		if (processed.type !== sourceAsset.kind) {
			throw new FiveCutImportError(
				`Asset ${sourceAsset.id} is declared as ${sourceAsset.kind} but decoded as ${processed.type}.`,
			);
		}
		mediaAssets.push({
			...processed,
			id: sourceAsset.id,
			duration: processed.duration ?? sourceAsset.duration,
			width: processed.width ?? sourceAsset.width,
			height: processed.height ?? sourceAsset.height,
			hasAudio: processed.hasAudio ?? sourceAsset.hasAudio,
		});
	}
	const assetMap = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const tracks = buildTracks({ document, assetMap, warnings });
	const now = new Date();
	const createdAt = parseDate(document.project.createdAt, now);
	const updatedAt = parseDate(document.project.updatedAt, createdAt);
	const sceneId = `${document.project.id}:scene`;
	const duration = Math.max(
		0,
		...document.tracks.flatMap((track) =>
			track.clips.map((clip) => toTicks(clip.start + clip.duration)),
		),
	);
	const fps: FrameRate = {
		numerator: document.project.canvas.fps.numerator,
		denominator: document.project.canvas.fps.denominator,
	};
	const project: TProject = {
		metadata: {
			id: document.project.id,
			name: document.project.name,
			duration,
			createdAt,
			updatedAt,
		},
		scenes: [
			{
				id: sceneId,
				name: "Main scene",
				isMain: true,
				tracks,
				bookmarks: (document.markers ?? []).map((marker) => ({
					time: toTicks(marker.time),
					duration:
						marker.duration !== undefined
							? toTicks(marker.duration)
							: undefined,
					note: marker.label,
					color: marker.color,
				})),
				createdAt,
				updatedAt,
			},
		],
		currentSceneId: sceneId,
		settings: {
			fps,
			canvasSize: {
				width: document.project.canvas.width,
				height: document.project.canvas.height,
			},
			canvasSizeMode: "custom",
			lastCustomCanvasSize: {
				width: document.project.canvas.width,
				height: document.project.canvas.height,
			},
			originalCanvasSize: null,
			background: {
				type: "color",
				color: document.project.background.color,
			},
		},
		version: CURRENT_PROJECT_VERSION,
	};
	return { document, project, mediaAssets, warnings };
}
