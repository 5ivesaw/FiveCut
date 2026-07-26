import { describe, expect, test } from "bun:test";
import {
	canToggleSourceAudio,
	doesElementHaveEnabledAudio,
} from "@/lib/timeline/audio-separation";
import type { VideoElement } from "@/lib/timeline";

function frozenVideo(): VideoElement {
	return {
		id: "freeze",
		type: "video",
		name: "Freeze",
		mediaId: "media",
		startTime: 0,
		duration: 240_000,
		trimStart: 0,
		trimEnd: 0,
		freezeFrameSourceTime: 120_000,
		isSourceAudioEnabled: true,
		muted: false,
		volume: 0,
		transform: {
			position: { x: 0, y: 0 },
			scaleX: 1,
			scaleY: 1,
			rotate: 0,
		},
		opacity: 1,
	};
}

describe("freeze-frame audio safety", () => {
	test("never exposes or mixes source audio for a held frame", () => {
		const element = frozenVideo();
		const media = { hasAudio: true };

		expect(canToggleSourceAudio(element, media)).toBe(false);
		expect(doesElementHaveEnabledAudio({ element, mediaAsset: media })).toBe(
			false,
		);
	});
});
