import type { Manifest } from '#shared/utils/manifest'

/**
 * A Live manifest's files in the shoot's folder: `manifest.json` and every recipe (`recipes.json`).
 * Written when the shoot goes Live, and again when a setting that only shapes the recipes (wording
 * mixes) changes before the first batch. Returns the recipes.
 */
export async function writeLiveFiles(base: string, shootCode: string, manifest: Manifest) {
  const recipes = buildRecipes(manifest)
  if (!recipes.length) throw new Error('These edits make no recipes: check the problems above')
  await dropboxUploader.writeText(`${base}/manifest.json`, JSON.stringify(manifest, null, 2))
  // every recipe, b-roll and all, fixed from here: batches reference them by id
  await dropboxUploader.writeText(`${base}/recipes.json`, JSON.stringify({
    schema_version: RECIPES_SCHEMA_VERSION,
    shoot: shootCode,
    manifest_version: manifest.version,
    generated_at: manifest.generated_at,
    // file paths are relative to the shoot's edited/ folder; a treated version uses the same takes,
    // and the renderer composes the treatment from their blocks
    recipes
  }, null, 2))
  return recipes
}
