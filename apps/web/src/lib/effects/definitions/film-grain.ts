import type { EffectDefinition } from "@/lib/effects/types";

export const filmGrainEffectDefinition: EffectDefinition = {
	type: "film-grain",
	name: "Film Grain",
	keywords: ["grain", "noise", "film", "texture"],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 0.08,
			min: 0,
			max: 0.5,
			step: 0.01,
		},
		{
			key: "size",
			label: "Grain size",
			type: "number",
			default: 2,
			min: 1,
			max: 12,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "film-grain",
				uniforms: ({ effectParams }) => ({
					u_intensity: Number(effectParams.intensity),
					u_size: Number(effectParams.size),
				}),
			},
		],
	},
};
