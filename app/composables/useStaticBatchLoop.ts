import type { LoadedShoot } from '#shared/utils/loadShoot'
import type { Manifest } from '#shared/utils/manifest'
import type { StaticRecipe, StaticElementKind } from '#shared/utils/staticRecipes'
import type { Score } from '#shared/utils/batchLoop'
import type { KanvasIndex, KanvasRender } from '#shared/utils/kanvas'
import type { BatchRow, BatchStatus } from '~/composables/useBatchLoop'

/**
 * A Live shoot's static batch loop (statics spec §7): its static recipes (from the Live manifest),
 * its static batches (SB##), their element scores and the elements dropped or kept by hand, the
 * reviews of Kanvas's renders, and Kanvas's index once read. Apart from video's, so scores never mix.
 */
export function useStaticBatchLoop(bundle: Ref<LoadedShoot>) {
  const db = useDb()
  const shoot = computed(() => bundle.value.shoot)
  const manifest = shallowRef<Manifest | null>(null)
  const batches = ref<BatchRow[]>([])
  const scores = ref<{ shortlist_id: string, element_kind: string, element_key: string, score: string }[]>([])
  const overrides = ref<{ element_kind: string, element_key: string, dropped: boolean }[]>([])
  const reviews = ref<{ shortlist_id: string, recipe_id: string, decision: string }[]>([])
  const kanvas = shallowRef<KanvasIndex | null>(null)
  const kanvasError = ref<string | null>(null)
  const loading = ref(false)

  async function load() {
    if (shoot.value.status !== 'edited' || !bundle.value.statics?.formats.length) return
    loading.value = true
    try {
      const [latest, rows, dropped] = await Promise.all([
        db.from('shoot_manifests').select('data').eq('shoot_id', shoot.value.id).order('version', { ascending: false }).limit(1).maybeSingle(),
        db.from('shoot_shortlists').select('id, code, size, entry_ids, manifest_version, status, status_at, exploit_share, created_at').eq('shoot_id', shoot.value.id).eq('medium', 'static').order('code'),
        db.from('shoot_element_overrides').select('element_kind, element_key, dropped').eq('shoot_id', shoot.value.id).in('element_kind', [...STATIC_ELEMENT_KINDS])
      ])
      manifest.value = (latest.data?.data ?? null) as Manifest | null
      batches.value = (rows.data ?? []) as BatchRow[]
      overrides.value = dropped.data ?? []
      const ids = batches.value.map(batch => batch.id)
      const [scored, reviewed] = ids.length
        ? await Promise.all([
            db.from('batch_scores').select('shortlist_id, element_kind, element_key, score').in('shortlist_id', ids),
            db.from('static_render_reviews').select('shortlist_id, recipe_id, decision').in('shortlist_id', ids)
          ])
        : [{ data: [] }, { data: [] }]
      scores.value = scored.data ?? []
      reviews.value = reviewed.data ?? []
    } finally {
      loading.value = false
    }
  }
  watch(() => [shoot.value.id, shoot.value.status], load, { immediate: true })

  const recipes = computed<StaticRecipe[]>(() => {
    const input = manifest.value ? staticInputFromManifest(manifest.value) : null
    return input ? buildStaticRecipes(input) : []
  })
  const recipeById = computed(() => new Map(recipes.value.map(recipe => [recipe.id, recipe])))
  /** recipes in a batch, less those rejected in review: those can be batched again */
  const batched = computed(() => new Set(batches.value.flatMap(batch => batch.entry_ids.filter(id => !rejected(batch, id)))))
  const measuredIds = computed(() => new Set(batches.value.filter(batch => batch.status === 'measured').map(batch => batch.id)))
  const records = computed(() => elementRecords(scores.value.filter(row => measuredIds.value.has(row.shortlist_id)), overrides.value))
  const canBatch = computed(() => batches.value.every(batch => batch.status === 'measured'))
  const used = computed(() => recipes.value.length ? batched.value.size / recipes.value.length : 0)

  const batchRecipes = (batch: BatchRow) => batch.entry_ids.map(id => recipeById.value.get(id)).filter((recipe): recipe is StaticRecipe => !!recipe)
  const scoresOf = (batch: BatchRow) => new Map(scores.value.filter(row => row.shortlist_id === batch.id).map(row => [`${row.element_kind}:${row.element_key}`, row.score as Score]))
  const reviewOf = (batch: BatchRow, recipeId: string) => reviews.value.find(row => row.shortlist_id === batch.id && row.recipe_id === recipeId)?.decision ?? null
  function rejected(batch: BatchRow, recipeId: string) {
    return reviewOf(batch, recipeId) === 'rejected'
  }

  /** Kanvas's renders of a batch, by recipe (from its index, once read) */
  const rendersOf = (batch: BatchRow): Map<string, KanvasRender> =>
    new Map((kanvas.value?.renders ?? []).filter(render => render.batch === batch.code).map(render => [render.recipe, render]))
  /** a batch's ads still waiting on a decision (a product Kanvas drew), which stop it being submitted */
  const undecided = (batch: BatchRow) => [...rendersOf(batch).values()]
    .filter(render => blockingFlags(render).length && !reviewOf(batch, render.recipe))
    .map(render => render.recipe)

  async function readKanvas(base: string) {
    kanvasError.value = null
    const text = await dropboxReadText(`${base}/edited/_kanvas.json`)
    if (text === null) {
      kanvas.value = null
      kanvasError.value = 'Kanvas hasn\'t written its index (edited/_kanvas.json) yet.'
      return
    }
    try {
      const parsed = parseKanvasIndex(JSON.parse(text))
      kanvas.value = parsed.index ?? null
      kanvasError.value = parsed.error ?? null
    } catch {
      kanvas.value = null
      kanvasError.value = 'Kanvas\'s index isn\'t valid JSON: it may still be writing it, so try again in a moment.'
    }
  }

  async function setScore(batch: BatchRow, kind: StaticElementKind, key: string, score: Score | null) {
    if (score) must(await db.from('batch_scores').upsert({ shortlist_id: batch.id, element_kind: kind, element_key: key, score, updated_at: new Date().toISOString() }))
    else must(await db.from('batch_scores').delete().eq('shortlist_id', batch.id).eq('element_kind', kind).eq('element_key', key))
    scores.value = [
      ...scores.value.filter(row => !(row.shortlist_id === batch.id && row.element_kind === kind && row.element_key === key)),
      ...(score ? [{ shortlist_id: batch.id, element_kind: kind, element_key: key, score }] : [])
    ]
  }
  async function setDropped(kind: StaticElementKind, key: string, dropped: boolean | null) {
    if (dropped === null) must(await db.from('shoot_element_overrides').delete().eq('shoot_id', shoot.value.id).eq('element_kind', kind).eq('element_key', key))
    else must(await db.from('shoot_element_overrides').upsert({ shoot_id: shoot.value.id, element_kind: kind, element_key: key, dropped }))
    overrides.value = [
      ...overrides.value.filter(row => !(row.element_kind === kind && row.element_key === key)),
      ...(dropped === null ? [] : [{ element_kind: kind, element_key: key, dropped }])
    ]
  }
  async function setReview(batch: BatchRow, recipeId: string, decision: 'approved' | 'rejected' | null) {
    if (decision) must(await db.from('static_render_reviews').upsert({ shortlist_id: batch.id, recipe_id: recipeId, decision, decided_at: new Date().toISOString() }))
    else must(await db.from('static_render_reviews').delete().eq('shortlist_id', batch.id).eq('recipe_id', recipeId))
    reviews.value = [
      ...reviews.value.filter(row => !(row.shortlist_id === batch.id && row.recipe_id === recipeId)),
      ...(decision ? [{ shortlist_id: batch.id, recipe_id: recipeId, decision }] : [])
    ]
  }
  async function setStatus(batch: BatchRow, status: BatchStatus) {
    const at = new Date().toISOString()
    must(await db.from('shoot_shortlists').update({ status, status_at: at }).eq('id', batch.id))
    Object.assign(batch, { status, status_at: at })
  }

  return {
    manifest, batches, scores, overrides, reviews, kanvas, kanvasError, loading, load, recipes, batched, records, canBatch, used,
    batchRecipes, scoresOf, reviewOf, rendersOf, undecided, readKanvas, setScore, setDropped, setReview, setStatus
  }
}

export type StaticBatchLoop = ReturnType<typeof useStaticBatchLoop>
