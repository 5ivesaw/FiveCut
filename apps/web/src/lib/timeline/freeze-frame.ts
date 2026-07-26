import {
	resolveOpacityAtTime,
	resolveTransformAtTime,
	splitAnimationsAtTime,
} from "@/lib/animation";
import { resolveEffectParamsAtTime } from "@/lib/animation/effect-param-channel";
import { getSourceSpanAtClipTime } from "@/lib/retime";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/lib/timeline/types";

export const DEFAULT_FREEZE_FRAME_DURATION = 2 * TICKS_PER_SECOND;

export type FreezeFrameFailureReason =
	| "invalid-duration"
	| "not-found"
	| "not-video"
	| "already-frozen"
	| "outside-clip";

export type FreezeFrameEditResult =
	| {
			ok: true;
			tracks: SceneTracks;
			freezeElement: ElementRef;
			sourceTime: number;
	  }
	| {
			ok: false;
			reason: FreezeFrameFailureReason;
	  };

type SplitElementResult = {
	left: TimelineElement | null;
	right: TimelineElement | null;
};

function splitElementForInsertedGap({
	element,
	splitTime,
	gapDuration,
	createId,
}: {
	element: TimelineElement;
	splitTime: number;
	gapDuration: number;
	createId: () => string;
}): SplitElementResult {
	const relativeTime = splitTime - element.startTime;
	if (relativeTime <= 0) {
		return {
			left: null,
			right: {
				...element,
				startTime: element.startTime + gapDuration,
			},
		};
	}

	if (relativeTime >= element.duration) {
		return { left: element, right: null };
	}

	const rightDuration = element.duration - relativeTime;
	const retime =
		element.type === "video" || element.type === "audio"
			? element.retime
			: undefined;
	const leftSourceSpan = getSourceSpanAtClipTime({
		clipTime: relativeTime,
		retime,
	});
	const totalSourceSpan = getSourceSpanAtClipTime({
		clipTime: element.duration,
		retime,
	});
	const rightSourceSpan = totalSourceSpan - leftSourceSpan;
	const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
		animations: element.animations,
		splitTime: relativeTime,
		shouldIncludeSplitBoundary: true,
	});

	return {
		left: {
			...element,
			duration: relativeTime,
			trimEnd: element.trimEnd + rightSourceSpan,
			animations: leftAnimations,
		},
		right: {
			...element,
			id: createId(),
			startTime: splitTime + gapDuration,
			duration: rightDuration,
			trimStart: element.trimStart + leftSourceSpan,
			animations: rightAnimations,
		},
	};
}

function createFrozenElement({
	element,
	id,
	startTime,
	duration,
	sourceTime,
}: {
	element: VideoElement;
	id: string;
	startTime: number;
	duration: number;
	sourceTime: number;
}): VideoElement {
	const localTime = startTime - element.startTime;

	return {
		...element,
		id,
		name: `${element.name} (freeze)`,
		startTime,
		duration,
		trimStart: 0,
		trimEnd: 0,
		sourceDuration: undefined,
		retime: undefined,
		animations: undefined,
		transform: resolveTransformAtTime({
			baseTransform: element.transform,
			animations: element.animations,
			localTime,
		}),
		opacity: resolveOpacityAtTime({
			baseOpacity: element.opacity,
			animations: element.animations,
			localTime,
		}),
		effects: element.effects?.map((effect) => ({
			...effect,
			params: resolveEffectParamsAtTime({
				effect,
				animations: element.animations,
				localTime,
			}),
		})),
		freezeFrameSourceTime: sourceTime,
		volume: 0,
		muted: true,
		isSourceAudioEnabled: false,
	};
}

function mapTrackWithInsertedGap<TTrack extends TimelineTrack>({
	track,
	target,
	atTime,
	duration,
	rippleAllTracks,
	createId,
	frozenElement,
}: {
	track: TTrack;
	target: ElementRef;
	atTime: number;
	duration: number;
	rippleAllTracks: boolean;
	createId: () => string;
	frozenElement: VideoElement;
}): TTrack {
	const shouldInsertGap = track.id === target.trackId || rippleAllTracks;
	if (!shouldInsertGap) {
		return track;
	}

	const elements = track.elements.flatMap((element): TimelineElement[] => {
		if (track.id === target.trackId && element.id === target.elementId) {
			const split = splitElementForInsertedGap({
				element,
				splitTime: atTime,
				gapDuration: duration,
				createId,
			});
			return [
				...(split.left ? [split.left] : []),
				frozenElement,
				...(split.right ? [split.right] : []),
			];
		}

		const elementEnd = element.startTime + element.duration;
		if (element.startTime >= atTime) {
			return [{ ...element, startTime: element.startTime + duration }];
		}
		if (elementEnd <= atTime) {
			return [element];
		}

		const split = splitElementForInsertedGap({
			element,
			splitTime: atTime,
			gapDuration: duration,
			createId,
		});
		return [
			...(split.left ? [split.left] : []),
			...(split.right ? [split.right] : []),
		];
	});

	return {
		...track,
		elements: elements.sort(
			(left, right) =>
				left.startTime - right.startTime || left.id.localeCompare(right.id),
		),
	} as TTrack;
}

export function createFreezeFrameEdit({
	tracks,
	target,
	atTime,
	duration = DEFAULT_FREEZE_FRAME_DURATION,
	rippleAllTracks = false,
	createId,
}: {
	tracks: SceneTracks;
	target: ElementRef;
	atTime: number;
	duration?: number;
	rippleAllTracks?: boolean;
	createId: () => string;
}): FreezeFrameEditResult {
	if (!Number.isFinite(duration) || duration <= 0) {
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
	if (targetElement.type !== "video") {
		return { ok: false, reason: "not-video" };
	}
	if (targetElement.freezeFrameSourceTime !== undefined) {
		return { ok: false, reason: "already-frozen" };
	}
	if (
		!Number.isFinite(atTime) ||
		atTime < targetElement.startTime ||
		atTime >= targetElement.startTime + targetElement.duration
	) {
		return { ok: false, reason: "outside-clip" };
	}

	const localTime = atTime - targetElement.startTime;
	const unclampedSourceTime =
		targetElement.trimStart +
		getSourceSpanAtClipTime({
			clipTime: localTime,
			retime: targetElement.retime,
		});
	const maximumSourceTime =
		typeof targetElement.sourceDuration === "number"
			? Math.max(
					targetElement.trimStart,
					targetElement.sourceDuration - targetElement.trimEnd - 1,
				)
			: unclampedSourceTime;
	const sourceTime = Math.max(
		0,
		Math.min(unclampedSourceTime, maximumSourceTime),
	);
	const freezeElementId = createId();
	const frozenElement = createFrozenElement({
		element: targetElement,
		id: freezeElementId,
		startTime: atTime,
		duration,
		sourceTime,
	});
	const mapTrack = <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
		mapTrackWithInsertedGap({
			track,
			target,
			atTime,
			duration,
			rippleAllTracks,
			createId,
			frozenElement,
		});

	return {
		ok: true,
		tracks: {
			overlay: tracks.overlay.map((track) => mapTrack(track)),
			main: mapTrack(tracks.main),
			audio: tracks.audio.map((track) => mapTrack(track)),
		},
		freezeElement: {
			trackId: target.trackId,
			elementId: freezeElementId,
		},
		sourceTime,
	};
}
