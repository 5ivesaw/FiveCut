import type { MediaType } from "@/lib/media/types";
import { DEFAULTS } from "@/lib/timeline/defaults";
import type {
	ElementRef,
	ImageElement,
	SceneTracks,
	TimelineElement,
	UploadAudioElement,
	VideoElement,
} from "@/lib/timeline/types";
import { updateElementInSceneTracks } from "@/lib/timeline/track-element-update";
import {
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/lib/retime";

export type ReplaceMediaFailureReason =
	| "not-found"
	| "incompatible-media"
	| "invalid-duration";

export type ReplaceMediaEditResult =
	| {
			ok: true;
			tracks: SceneTracks;
			element: ElementRef;
	  }
	| {
			ok: false;
			reason: ReplaceMediaFailureReason;
	  };

export interface ReplacementMedia {
	id: string;
	name: string;
	type: MediaType;
	/** Full source duration in editor ticks. Images do not need a duration. */
	duration?: number;
}

function fitTimedSource({
	requestedDuration,
	sourceDuration,
	requestedTrimStart,
	retime,
}: {
	requestedDuration: number;
	sourceDuration: number;
	requestedTrimStart: number;
	retime?: VideoElement["retime"];
}): {
	duration: number;
	trimStart: number;
	trimEnd: number;
} {
	const trimStart =
		requestedTrimStart >= 0 && requestedTrimStart < sourceDuration
			? requestedTrimStart
			: 0;
	const availableSourceSpan = Math.max(1, sourceDuration - trimStart);
	const maximumTimelineDuration = Math.max(
		1,
		Math.floor(
			getTimelineDurationForSourceSpan({
				sourceSpan: availableSourceSpan,
				retime,
			}),
		),
	);
	const duration = Math.max(
		1,
		Math.min(Math.round(requestedDuration), maximumTimelineDuration),
	);
	const visibleSourceSpan = Math.min(
		availableSourceSpan,
		getSourceSpanAtClipTime({ clipTime: duration, retime }),
	);

	return {
		duration,
		trimStart,
		trimEnd: Math.max(0, sourceDuration - trimStart - visibleSourceSpan),
	};
}

function buildVisualReplacement({
	target,
	media,
}: {
	target: VideoElement | ImageElement;
	media: ReplacementMedia;
}): VideoElement | ImageElement | null {
	if (media.type === "audio") {
		return null;
	}

	const shared = {
		id: target.id,
		name: media.name,
		mediaId: media.id,
		startTime: target.startTime,
		hidden: target.hidden,
		transform: target.transform,
		opacity: target.opacity,
		blendMode: target.blendMode,
		effects: target.effects,
		masks: target.masks,
		animations: target.animations,
	};

	if (media.type === "image") {
		return {
			...shared,
			type: "image",
			duration: target.duration,
			trimStart: 0,
			trimEnd: 0,
		};
	}

	const sourceDuration = media.duration;
	if (sourceDuration === undefined) {
		return {
			...shared,
			type: "video",
			duration: target.duration,
			trimStart: 0,
			trimEnd: 0,
			sourceDuration: target.duration,
			volume: target.type === "video" ? target.volume : DEFAULTS.element.volume,
			muted: target.type === "video" ? target.muted : false,
			isSourceAudioEnabled:
				target.type === "video" ? target.isSourceAudioEnabled : true,
		};
	}

	const retime = target.type === "video" ? target.retime : undefined;
	const fit = fitTimedSource({
		requestedDuration: target.duration,
		sourceDuration,
		requestedTrimStart: target.type === "video" ? target.trimStart : 0,
		retime,
	});

	return {
		...shared,
		type: "video",
		...fit,
		sourceDuration,
		retime,
		volume: target.type === "video" ? target.volume : DEFAULTS.element.volume,
		muted: target.type === "video" ? target.muted : false,
		isSourceAudioEnabled:
			target.type === "video" ? target.isSourceAudioEnabled : true,
	};
}

function buildAudioReplacement({
	target,
	media,
}: {
	target: Extract<TimelineElement, { type: "audio" }>;
	media: ReplacementMedia;
}): UploadAudioElement | null {
	if (media.type !== "audio") {
		return null;
	}

	const sourceDuration = media.duration ?? target.duration;
	const fit = fitTimedSource({
		requestedDuration: target.duration,
		sourceDuration,
		requestedTrimStart: target.trimStart,
		retime: target.retime,
	});

	return {
		id: target.id,
		type: "audio",
		sourceType: "upload",
		mediaId: media.id,
		name: media.name,
		startTime: target.startTime,
		...fit,
		sourceDuration,
		volume: target.volume,
		muted: target.muted,
		retime: target.retime,
		animations: target.animations,
	};
}

export function createReplaceMediaEdit({
	tracks,
	target,
	media,
}: {
	tracks: SceneTracks;
	target: ElementRef;
	media: ReplacementMedia;
}): ReplaceMediaEditResult {
	if (
		media.duration !== undefined &&
		(!Number.isFinite(media.duration) || media.duration <= 0)
	) {
		return { ok: false, reason: "invalid-duration" };
	}

	const targetTrack =
		tracks.main.id === target.trackId
			? tracks.main
			: (tracks.overlay.find((track) => track.id === target.trackId) ??
				tracks.audio.find((track) => track.id === target.trackId));
	const targetElement = targetTrack?.elements.find(
		(element) => element.id === target.elementId,
	);
	if (!targetElement) {
		return { ok: false, reason: "not-found" };
	}

	const replacement =
		targetElement.type === "video" || targetElement.type === "image"
			? buildVisualReplacement({ target: targetElement, media })
			: targetElement.type === "audio"
				? buildAudioReplacement({ target: targetElement, media })
				: null;
	if (!replacement) {
		return { ok: false, reason: "incompatible-media" };
	}

	return {
		ok: true,
		tracks: updateElementInSceneTracks({
			tracks,
			trackId: target.trackId,
			elementId: target.elementId,
			update: () => replacement,
		}),
		element: target,
	};
}
