import { describe, expect, test } from "bun:test";
import { createReplaceMediaEdit } from "@/lib/timeline/replace-media";
import type {
	AudioTrack,
	SceneTracks,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/lib/timeline";

const transform = {
	position: { x: 120, y: -40 },
	scaleX: 1.2,
	scaleY: 1.2,
	rotate: 3,
};

function video(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "clip",
		type: "video",
		name: "Old source",
		mediaId: "old-media",
		startTime: 100,
		duration: 600,
		trimStart: 100,
		trimEnd: 300,
		sourceDuration: 1_000,
		transform,
		opacity: 0.8,
		volume: 0.7,
		muted: true,
		isSourceAudioEnabled: false,
		freezeFrameSourceTime: 250,
		...overrides,
	};
}

function audio(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "audio",
		type: "audio",
		sourceType: "upload",
		name: "Old audio",
		mediaId: "old-audio",
		startTime: 200,
		duration: 500,
		trimStart: 100,
		trimEnd: 400,
		sourceDuration: 1_000,
		volume: 0.6,
		muted: false,
		retime: { rate: 2, maintainPitch: true },
		...overrides,
	};
}

function videoTrack(elements: VideoTrack["elements"]): VideoTrack {
	return {
		id: "main",
		type: "video",
		name: "Main",
		elements,
		muted: false,
		hidden: false,
	};
}

function audioTrack(elements: AudioTrack["elements"]): AudioTrack {
	return {
		id: "audio-track",
		type: "audio",
		name: "Audio",
		elements,
		muted: false,
	};
}

function scene({
	main = videoTrack([video()]),
	audioTracks = [],
}: {
	main?: VideoTrack;
	audioTracks?: AudioTrack[];
} = {}): SceneTracks {
	return { overlay: [], main, audio: audioTracks };
}

describe("createReplaceMediaEdit", () => {
	test("replaces a video while preserving timeline and visual edits", () => {
		const result = createReplaceMediaEdit({
			tracks: scene(),
			target: { trackId: "main", elementId: "clip" },
			media: {
				id: "new-media",
				name: "New source",
				type: "video",
				duration: 2_000,
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const replacement = result.tracks.main.elements[0] as VideoElement;
		expect(replacement).toMatchObject({
			id: "clip",
			type: "video",
			mediaId: "new-media",
			name: "New source",
			startTime: 100,
			duration: 600,
			trimStart: 100,
			trimEnd: 1_300,
			sourceDuration: 2_000,
			transform,
			opacity: 0.8,
			volume: 0.7,
			muted: true,
			isSourceAudioEnabled: false,
		});
		expect(replacement.freezeFrameSourceTime).toBeUndefined();
	});

	test("clamps the clip when the replacement source is shorter", () => {
		const result = createReplaceMediaEdit({
			tracks: scene({
				main: videoTrack([video({ retime: { rate: 2 } })]),
			}),
			target: { trackId: "main", elementId: "clip" },
			media: {
				id: "short-media",
				name: "Short",
				type: "video",
				duration: 1_000,
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tracks.main.elements[0]).toMatchObject({
			duration: 450,
			trimStart: 100,
			trimEnd: 0,
			retime: { rate: 2 },
		});
	});

	test("can replace a video with a still while keeping its composition", () => {
		const result = createReplaceMediaEdit({
			tracks: scene(),
			target: { trackId: "main", elementId: "clip" },
			media: { id: "still", name: "Still", type: "image" },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tracks.main.elements[0]).toMatchObject({
			id: "clip",
			type: "image",
			mediaId: "still",
			duration: 600,
			startTime: 100,
			transform,
			opacity: 0.8,
			trimStart: 0,
			trimEnd: 0,
		});
	});

	test("replaces uploaded audio and preserves its mix and speed", () => {
		const result = createReplaceMediaEdit({
			tracks: scene({ audioTracks: [audioTrack([audio()])] }),
			target: { trackId: "audio-track", elementId: "audio" },
			media: {
				id: "new-audio",
				name: "New audio",
				type: "audio",
				duration: 2_000,
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tracks.audio[0].elements[0]).toMatchObject({
			id: "audio",
			sourceType: "upload",
			mediaId: "new-audio",
			duration: 500,
			trimStart: 100,
			trimEnd: 900,
			volume: 0.6,
			retime: { rate: 2, maintainPitch: true },
		});
	});

	test("rejects incompatible media without modifying the project", () => {
		const result = createReplaceMediaEdit({
			tracks: scene(),
			target: { trackId: "main", elementId: "clip" },
			media: {
				id: "audio",
				name: "Audio",
				type: "audio",
				duration: 500,
			},
		});

		expect(result).toEqual({ ok: false, reason: "incompatible-media" });
	});
});
