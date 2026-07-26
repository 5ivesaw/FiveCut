import { z } from "zod";

const id = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const time = z.number().finite().min(0).max(864000);
const positiveTime = z.number().finite().positive().max(864000);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);

const transform = z
	.object({
		positionX: z.number().finite().min(-32768).max(32768).optional(),
		positionY: z.number().finite().min(-32768).max(32768).optional(),
		scaleX: z.number().finite().min(-100).max(100).optional(),
		scaleY: z.number().finite().min(-100).max(100).optional(),
		rotation: z.number().finite().min(-36000).max(36000).optional(),
		anchorX: z.number().finite().min(0).max(1).optional(),
		anchorY: z.number().finite().min(0).max(1).optional(),
	})
	.strict();

const transition = z
	.object({
		type: z.enum([
			"none",
			"fade",
			"dissolve",
			"slide-left",
			"slide-right",
			"zoom",
		]),
		duration: z.number().finite().min(0).max(10),
	})
	.strict();

const effect = z
	.object({
		id,
		type: z.enum(["color-grade", "blur", "sharpen", "pixelate", "film-grain"]),
		enabled: z.boolean().optional(),
		params: z
			.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
			.optional(),
	})
	.strict();

const keyframe = z
	.object({
		id,
		property: z.enum([
			"opacity",
			"volumeDb",
			"transform.positionX",
			"transform.positionY",
			"transform.scaleX",
			"transform.scaleY",
			"transform.rotation",
		]),
		time,
		value: z.union([z.number().finite(), z.string(), z.boolean()]),
		interpolation: z
			.enum(["hold", "linear", "ease-in", "ease-out", "ease-in-out"])
			.optional(),
	})
	.strict();

const textStyle = z
	.object({
		fontFamily: z.string().min(1).optional(),
		fontFileAssetId: id.optional(),
		fontSize: z.number().finite().min(1).max(2000).optional(),
		fontWeight: z.enum(["normal", "bold"]).optional(),
		fontStyle: z.enum(["normal", "italic"]).optional(),
		color: color.optional(),
		backgroundColor: color.optional(),
		outlineColor: color.optional(),
		outlineWidth: z.number().finite().min(0).max(30).optional(),
		alignment: z.enum(["left", "center", "right"]).optional(),
		position: z
			.enum(["top", "upper-third", "center", "lower-third", "bottom"])
			.optional(),
		marginX: z.number().int().min(0).max(4000).optional(),
		marginY: z.number().int().min(0).max(4000).optional(),
	})
	.strict();

const clip = z
	.object({
		id,
		type: z.enum(["media", "text", "caption", "shape"]),
		name: z.string().max(500).optional(),
		assetId: id.optional(),
		text: z.string().max(100000).optional(),
		start: time,
		duration: positiveTime,
		sourceIn: time.optional(),
		sourceDuration: positiveTime.optional(),
		speed: z.number().finite().min(0.05).max(20).optional(),
		opacity: z.number().finite().min(0).max(1).optional(),
		volumeDb: z.number().finite().min(-96).max(24).optional(),
		muted: z.boolean().optional(),
		includeSourceAudio: z.boolean().optional(),
		transform: transform.optional(),
		transitionIn: transition.optional(),
		transitionOut: transition.optional(),
		effects: z.array(effect).optional(),
		keyframes: z.array(keyframe).optional(),
		style: textStyle.optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.type === "media" && !value.assetId) {
			context.addIssue({
				code: "custom",
				path: ["assetId"],
				message: "Media clips require assetId.",
			});
		}
		if (
			(value.type === "text" || value.type === "caption") &&
			value.text === undefined
		) {
			context.addIssue({
				code: "custom",
				path: ["text"],
				message: "Text and caption clips require text.",
			});
		}
		if (
			value.transitionIn &&
			value.transitionIn.duration > value.duration / 2
		) {
			context.addIssue({
				code: "custom",
				path: ["transitionIn", "duration"],
				message: "Transition cannot exceed half of the clip duration.",
			});
		}
		if (
			value.transitionOut &&
			value.transitionOut.duration > value.duration / 2
		) {
			context.addIssue({
				code: "custom",
				path: ["transitionOut", "duration"],
				message: "Transition cannot exceed half of the clip duration.",
			});
		}
	});

const asset = z
	.object({
		id,
		kind: z.enum(["video", "audio", "image", "subtitle", "font", "other"]),
		path: z.string().min(1).max(4096),
		sha256: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.optional(),
		optional: z.boolean().optional(),
		duration: positiveTime.optional(),
		width: z.number().int().positive().optional(),
		height: z.number().int().positive().optional(),
		hasAudio: z.boolean().optional(),
		license: z.string().max(200).optional(),
		attribution: z.string().max(4000).optional(),
		sourceUrl: z.string().url().optional(),
		tags: z.array(z.string().max(100)).optional(),
	})
	.strict();

const track = z
	.object({
		id,
		kind: z.enum(["video", "audio", "caption", "graphic", "adjustment"]),
		name: z.string().min(1).max(200),
		muted: z.boolean().optional(),
		hidden: z.boolean().optional(),
		locked: z.boolean().optional(),
		clips: z.array(clip),
	})
	.strict();

export const fiveCutProjectSchema = z
	.object({
		$schema: z.string().optional(),
		format: z.literal("fivecut-project"),
		version: z.literal("1.0.0"),
		compatibility: z
			.object({
				minimumAppVersion: z.string().optional(),
				requiredCapabilities: z.array(z.string()).optional(),
			})
			.strict()
			.optional(),
		project: z
			.object({
				id,
				name: z.string().min(1).max(200),
				description: z.string().max(4000).optional(),
				intent: z.string().max(12000).optional(),
				seed: z.number().int().min(0).max(4294967295),
				canvas: z
					.object({
						width: z.number().int().min(16).max(16384),
						height: z.number().int().min(16).max(16384),
						fps: z
							.object({
								numerator: z.number().int().positive().max(240000),
								denominator: z.number().int().positive().max(1001),
							})
							.strict(),
						sampleRate: z
							.union([z.literal(44100), z.literal(48000), z.literal(96000)])
							.optional(),
					})
					.strict(),
				background: z.object({ color }).strict(),
				createdAt: z.string().datetime().optional(),
				updatedAt: z.string().datetime().optional(),
				generator: z.string().max(200).optional(),
			})
			.strict(),
		assets: z.array(asset),
		tracks: z.array(track),
		markers: z
			.array(
				z
					.object({
						id,
						time,
						duration: time.optional(),
						label: z.string().max(500),
						color: color.optional(),
					})
					.strict(),
			)
			.optional(),
		export: z
			.object({
				output: z.string().min(1).max(4096),
				container: z.enum(["mp4", "webm", "mov"]),
				videoCodec: z.enum(["h264", "h265", "vp9", "prores"]),
				audioCodec: z.enum(["aac", "opus", "pcm"]),
				quality: z.enum(["draft", "standard", "high", "master"]),
				pixelFormat: z.enum(["yuv420p", "yuv422p10le", "yuva420p"]).optional(),
				videoBitrate: z.string().optional(),
				audioBitrate: z.string().optional(),
				start: time.optional(),
				duration: positiveTime.optional(),
				loudnessTargetLufs: z.number().min(-36).max(-5).optional(),
				overwrite: z.boolean().optional(),
				metadata: z.record(z.string(), z.string()).optional(),
			})
			.strict(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export type FiveCutProjectDocument = z.infer<typeof fiveCutProjectSchema>;
export type FiveCutClip =
	FiveCutProjectDocument["tracks"][number]["clips"][number];
