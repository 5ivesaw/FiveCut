import type { EffectDefinition } from "@/lib/effects/types";

type GradeDefaults = {
	brightness: number;
	contrast: number;
	saturation: number;
	temperature: number;
	tint: number;
	vignette: number;
};

const neutral: GradeDefaults = {
	brightness: 0,
	contrast: 1,
	saturation: 1,
	temperature: 0,
	tint: 0,
	vignette: 0,
};

function numberParam(
	key: keyof GradeDefaults,
	label: string,
	defaultValue: number,
	min: number,
	max: number,
	step: number,
) {
	return {
		key,
		label,
		type: "number" as const,
		default: defaultValue,
		min,
		max,
		step,
	};
}

export function createColorGradeDefinition({
	type,
	name,
	defaults = neutral,
	keywords = [],
}: {
	type: string;
	name: string;
	defaults?: GradeDefaults;
	keywords?: string[];
}): EffectDefinition {
	return {
		type,
		name,
		keywords: ["color", "grade", "correction", "contrast", ...keywords],
		params: [
			numberParam("brightness", "Brightness", defaults.brightness, -1, 1, 0.01),
			numberParam("contrast", "Contrast", defaults.contrast, 0, 2, 0.01),
			numberParam("saturation", "Saturation", defaults.saturation, 0, 2, 0.01),
			numberParam(
				"temperature",
				"Temperature",
				defaults.temperature,
				-1,
				1,
				0.01,
			),
			numberParam("tint", "Tint", defaults.tint, -1, 1, 0.01),
			numberParam("vignette", "Vignette", defaults.vignette, 0, 1, 0.01),
		],
		renderer: {
			passes: [
				{
					shader: "color-grade",
					uniforms: ({ effectParams }) => ({
						u_brightness: Number(effectParams.brightness),
						u_contrast: Number(effectParams.contrast),
						u_saturation: Number(effectParams.saturation),
						u_temperature: Number(effectParams.temperature),
						u_tint: Number(effectParams.tint),
						u_vignette: Number(effectParams.vignette),
					}),
				},
			],
		},
	};
}

export const colorGradeDefinitions: EffectDefinition[] = [
	createColorGradeDefinition({
		type: "color-grade",
		name: "Color Grade",
		keywords: ["manual", "exposure"],
	}),
	createColorGradeDefinition({
		type: "cinematic-warm",
		name: "Cinematic Warm",
		keywords: ["film", "warm", "orange"],
		defaults: {
			brightness: -0.015,
			contrast: 1.13,
			saturation: 0.93,
			temperature: 0.2,
			tint: 0.025,
			vignette: 0.24,
		},
	}),
	createColorGradeDefinition({
		type: "creator-pop",
		name: "Creator Pop",
		keywords: ["vibrant", "youtube", "social"],
		defaults: {
			brightness: 0.025,
			contrast: 1.1,
			saturation: 1.22,
			temperature: 0.035,
			tint: 0,
			vignette: 0.08,
		},
	}),
	createColorGradeDefinition({
		type: "noir",
		name: "Noir",
		keywords: ["black", "white", "monochrome"],
		defaults: {
			brightness: -0.03,
			contrast: 1.2,
			saturation: 0,
			temperature: 0,
			tint: 0,
			vignette: 0.32,
		},
	}),
	createColorGradeDefinition({
		type: "cool-clean",
		name: "Cool Clean",
		keywords: ["blue", "clean", "tech"],
		defaults: {
			brightness: 0.015,
			contrast: 1.07,
			saturation: 0.96,
			temperature: -0.16,
			tint: -0.015,
			vignette: 0.1,
		},
	}),
];
