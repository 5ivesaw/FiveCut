import { describe, expect, test } from "bun:test";
import { createFreezeFrameEdit } from "@/lib/timeline/freeze-frame";
import type {
	AudioTrack,
	SceneTracks,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/lib/timeline";

function video(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Interview",
		mediaId: "media-1",
		startTime: 0,
		duration: 1_200,
		trimStart: 100,
		trimEnd: 100,
		sourceDuration: 1_400,
		transform: {
			position: { x: 0, y: 0 },
			scaleX: 1,
			scaleY: 1,
			rotate: 0,
		},
		opacity: 1,
		volume: 1,
		muted: false,
		isSourceAudioEnabled: true,
		...overrides,
	};
}

function audio(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "audio-1",
		type: "audio",
		sourceType: "upload",
		name: "Dialogue",
		mediaId: "audio-media",
		startTime: 0,
		duration: 1_200,
		trimStart: 0,
		trimEnd: 0,
		sourceDuration: 1_200,
		volume: 1,
		...overrides,
	};
}

function videoTrack(elements: VideoTrack["elements"]): VideoTrack {
	return {
		id: "main",
		name: "Main",
		type: "video",
		elements,
		muted: false,
		hidden: false,
	};
}

function audioTrack(elements: AudioTrack["elements"]): AudioTrack {
	return {
		id: "audio",
		name: "Audio",
		type: "audio",
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

function ids() {
	let index = 0;
	return () => `generated-${++index}`;
}

describe("createFreezeFrameEdit", () => {
	test("inserts a silent held frame and resumes the source after it", () => {
		const result = createFreezeFrameEdit({
			tracks: scene(),
			target: { trackId: "main", elementId: "video-1" },
			atTime: 500,
			duration: 200,
			createId: ids(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.sourceTime).toBe(600);
		expect(result.freezeElement).toEqual({
			trackId: "main",
			elementId: "generated-1",
		});
		expect(result.tracks.main.elements).toHaveLength(3);

		const [left, frozen, right] = result.tracks.main.elements;
		expect(left).toMatchObject({
			id: "video-1",
			startTime: 0,
			duration: 500,
			trimStart: 100,
			trimEnd: 800,
		});
		expect(frozen).toMatchObject({
			id: "generated-1",
			startTime: 500,
			duration: 200,
			freezeFrameSourceTime: 600,
			muted: true,
			isSourceAudioEnabled: false,
		});
		expect(right).toMatchObject({
			id: "generated-2",
			startTime: 700,
			duration: 700,
			trimStart: 600,
			trimEnd: 100,
		});
	});

	test("uses the retimed source timestamp", () => {
		const result = createFreezeFrameEdit({
			tracks: scene({
				main: videoTrack([video({ retime: { rate: 2 } })]),
			}),
			target: { trackId: "main", elementId: "video-1" },
			atTime: 300,
			duration: 100,
			createId: ids(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sourceTime).toBe(700);
	});

	test("shifts later clips on the edited track", () => {
		const later = video({
			id: "video-2",
			startTime: 1_200,
			duration: 300,
		});
		const result = createFreezeFrameEdit({
			tracks: scene({ main: videoTrack([video(), later]) }),
			target: { trackId: "main", elementId: "video-1" },
			atTime: 500,
			duration: 200,
			createId: ids(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.tracks.main.elements.find((element) => element.id === "video-2")
				?.startTime,
		).toBe(1_400);
	});

	test("splits crossing clips on other tracks when ripple is enabled", () => {
		const result = createFreezeFrameEdit({
			tracks: scene({ audioTracks: [audioTrack([audio()])] }),
			target: { trackId: "main", elementId: "video-1" },
			atTime: 500,
			duration: 200,
			rippleAllTracks: true,
			createId: ids(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tracks.audio[0].elements).toHaveLength(2);
		expect(result.tracks.audio[0].elements[0]).toMatchObject({
			id: "audio-1",
			duration: 500,
		});
		expect(result.tracks.audio[0].elements[1]).toMatchObject({
			startTime: 700,
			duration: 700,
			trimStart: 500,
		});
	});

	test("rejects invalid targets without changing tracks", () => {
		const notFound = createFreezeFrameEdit({
			tracks: scene(),
			target: { trackId: "main", elementId: "missing" },
			atTime: 500,
			createId: ids(),
		});
		expect(notFound).toEqual({ ok: false, reason: "not-found" });

		const outside = createFreezeFrameEdit({
			tracks: scene(),
			target: { trackId: "main", elementId: "video-1" },
			atTime: 1_200,
			createId: ids(),
		});
		expect(outside).toEqual({ ok: false, reason: "outside-clip" });
	});
});
