import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { colorGradeDefinitions } from "./color-grade";
import { filmGrainEffectDefinition } from "./film-grain";
import { pixelateEffectDefinition } from "./pixelate";
import { sharpenEffectDefinition } from "./sharpen";

const defaultEffects = [
	blurEffectDefinition,
	...colorGradeDefinitions,
	filmGrainEffectDefinition,
	pixelateEffectDefinition,
	sharpenEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register(definition.type, definition);
	}
}
