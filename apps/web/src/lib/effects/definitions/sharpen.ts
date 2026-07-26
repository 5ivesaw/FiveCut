import type { EffectDefinition } from "@/lib/effects/types";

export const sharpenEffectDefinition: EffectDefinition = {
	type: "sharpen",
	name: "Sharpen",
	keywords: ["detail", "crisp", "clarity"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 0.18,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [
			{
				shader: "sharpen",
				uniforms: ({ effectParams }) => ({
					u_amount: Number(effectParams.amount),
				}),
			},
		],
	},
};
