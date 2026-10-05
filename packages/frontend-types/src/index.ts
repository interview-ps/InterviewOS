/**
 * Frontend model types, generated from the FastAPI schema export
 * (`apps/api/schema/*.json`) by `apps/api/scripts/generate_ts_types.py`.
 *
 * At cut-over this replaces the hand-written `packages/core` model types.
 * Regenerate with:
 *   uv run --project apps/api python scripts/generate_ts_types.py \
 *     packages/frontend-types/src/generated.ts
 */
export * from "./generated";
export * from "./ui";
export * as taxonomy from "./taxonomy";
export { VOICE_DISCLAIMER } from "./voice";
