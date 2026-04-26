import type { DiffUnit, ModelBatch } from "./types.js";

const MAX_UNITS_PER_MODEL_CALL = 4;

export function createModelBatches(units: readonly DiffUnit[]): readonly ModelBatch[] {
  const batches: ModelBatch[] = [];
  for (let index = 0; index < units.length; index += MAX_UNITS_PER_MODEL_CALL) {
    batches.push({
      id: `batch-${String(batches.length + 1).padStart(3, "0")}`,
      units: units.slice(index, index + MAX_UNITS_PER_MODEL_CALL),
    });
  }
  return batches;
}
