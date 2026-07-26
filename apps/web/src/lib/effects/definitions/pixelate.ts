import type { EffectDefinition } from "@/lib/effects/types";

export const pixelateEffectDefinition: EffectDefinition = {
	type: "pixelate",
	name: "Pixelate",
	keywords: ["pixel", "mosaic", "censor", "retro"],
	params: [
		{
			key: "pixelSize",
			label: "Pixel size",
			type: "number",
			default: 16,
			min: 2,
			max: 160,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "pixelate",
				uniforms: ({ effectParams }) => ({
					u_pixel_size: Number(effectParams.pixelSize),
				}),
			},
		],
	},
};
