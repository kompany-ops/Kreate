// Build a shoot's whole folder tree in Dropbox (spec §10d): every clip folder under raw/ and
// edited/, plus renders/ and its brand's _kit/ (statics spec §3), and (until the edits are in) the plan as manifest.json. Folders that already exist are left
// exactly as they are (no renaming, nothing removed), so this is safe to run again and again:
// after planning, before each upload, or by hand. Any member of the org; not for drafts, whose
// codes can still change.
export default defineEventHandler(async (event) => {
  const { db } = await requireMember(event)
  const { shootCode } = await readBody<{ shootCode?: string }>(event)
  if (!shootCode) throw createError({ statusCode: 400, statusMessage: 'Which shoot?' })

  const bundle = await loadShootBundle(db, shootCode)
  if (!bundle) throw createError({ statusCode: 404, statusMessage: 'Shoot not found' })
  if (bundle.shoot.status === 'draft') throw createError({ statusCode: 409, statusMessage: 'Mark the shoot as planned first: its codes can still change' })

  const { accessToken, root } = await dropboxAccess(event, db)
  const auth = { Authorization: `Bearer ${accessToken}` }
  // the shoot's folders, and its brand's design kit folder (logo/, fonts/, packshots/) for Kanvas
  const kitFolder = brandKitFolder(bundle.brand.slug)
  const paths = [...skeletonFolders(bundle), ...BRAND_KIT_FOLDERS.map(folder => `${kitFolder}/${folder}`)].map(folder => `${root}/${folder}`)

  // autorename off: a folder that's already there comes back as a conflict and is left alone
  type Entry = { '.tag': 'success' } | { '.tag': 'failure', failure: { '.tag': string, path?: { '.tag': string } } }
  type Launch = { '.tag': 'complete', entries: Entry[] } | { '.tag': 'async_job_id', async_job_id: string } | { '.tag': 'in_progress' | 'failed' }
  let result = await $fetch<Launch>('https://api.dropboxapi.com/2/files/create_folder_batch', {
    method: 'POST',
    headers: auth,
    body: { paths, autorename: false }
  })
  // big batches run in the background: check on the job until it's done
  const jobId = result['.tag'] === 'async_job_id' ? result.async_job_id : null
  for (let attempt = 0; jobId && result['.tag'] !== 'complete' && result['.tag'] !== 'failed' && attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    result = await $fetch<Launch>('https://api.dropboxapi.com/2/files/create_folder_batch/check', {
      method: 'POST',
      headers: auth,
      body: { async_job_id: jobId }
    })
  }
  if (result['.tag'] !== 'complete') throw createError({ statusCode: 502, statusMessage: 'Dropbox didn\'t finish creating the folders. Try again.' })

  const created = result.entries.filter(entry => entry['.tag'] === 'success').length
  const failed = result.entries.filter(entry => entry['.tag'] === 'failure' && entry.failure.path?.['.tag'] !== 'conflict').length

  // the kit records where its folder is (the team only: cast building the folders leave it be)
  await db.from('brand_kits').upsert({ brand_id: bundle.brand.id, dropbox_path: `${root}/${kitFolder}` }, { onConflict: 'brand_id' })

  // the plan's manifest, regenerated so it matches the plan; once the shoot is ready for
  // batching, the full manifest (with every clip) is there and left alone
  if (['planned', 'shooting', 'filmed'].includes(bundle.shoot.status)) {
    await dropboxWriteText(accessToken, `${root}/${shootFolder(bundle)}/manifest.json`, JSON.stringify(planManifest(bundle), null, 2))
  }

  return { folders: paths.length, created, existing: paths.length - created - failed, failed, root: `${root}/${shootFolder(bundle)}` }
})
