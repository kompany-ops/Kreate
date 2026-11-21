// Clips added on set are saved on the phone first, then sent to Dropbox straight away, one at a
// time, while the app is open and online (spec §12). Saving a clip is what ticks a deliverable
// off. Saved clips live in IndexedDB, so they survive reloads, closing the app and a flat
// battery; each one is let go from the phone once its upload is confirmed, and anything that
// didn't go through is sent the next time the app is open and online. Replacing or removing a
// clip that's already uploaded takes the old one out of Dropbox too.
//
// One take can fill several spots: a line that uses no channel slot is recorded once and used
// on each of the person's channels, so the clip is saved once under its first spot (`target`)
// with the others in `also`, uploaded once and copied in Dropbox to the other channels' folders.

/**
 * saved: on this phone, waiting to be uploaded. failed: the upload didn't go through; retried with
 * the rest. lost: marked uploaded by the old test mode, which never sent it and let it go from
 * this phone; it has to be added again (from Photos) and uploaded.
 */
export type ClipState = 'saved' | 'uploading' | 'uploaded' | 'failed' | 'lost'

/** Another spot the same take fills: its target and where it goes in Dropbox (no extension). */
export interface ClipSpot {
  target: string
  dest: string
  /** its copy's full Dropbox path, once uploaded */
  path?: string | null
}

export interface AttachedClip {
  /** the shoot code it was filmed for */
  shoot: string
  /** its first spot; `also` holds any others the same take fills */
  target: string
  also: ClipSpot[]
  /** when it was saved on this phone (ms); clips saved before the shoot was reverted are dropped */
  savedAt?: number
  name: string
  type: string
  size: number
  /** the clip itself until it's uploaded; null afterwards */
  file: Blob | null
  /** object URL for the preview; empty for a clip uploaded in an earlier session */
  url: string
  /**
   * Where it goes in Dropbox, as a file without extension: `…/raw/topdognix/hooks/joe/H01`, or
   * for b-roll the clip's own name in its folder. Named clips replace what's there; b-roll never
   * overwrites.
   */
  dest: string
  /** b-roll: keep both if the name's taken (Dropbox adds a number) instead of replacing */
  keepBoth?: boolean
  /** what was said (hooks, CTAs, VO beats), for its captions */
  script?: string | null
  /** its length in seconds, as measured when it was added */
  duration?: number | null
  state: ClipState
  /** upload progress, 0 to 1 */
  progress: number
  path: string | null
  /** what the sanity checks measured, e.g. "1080×1920 · 9:16 · 30 fps" */
  details: string | null
  /** what looked wrong (saved anyway) */
  issues: string[]
}

/** Where a clip goes: Dropbox (utils/dropboxUploader.ts). There's no test mode: without Dropbox, nothing uploads. */
export interface ClipUploader {
  connected: boolean
  /**
   * `path` is the full Dropbox path, extension included. An existing file there is replaced,
   * or with `keepBoth` kept, the upload getting a numbered name instead.
   */
  upload(file: Blob, path: string, keepBoth: boolean, onProgress: (fraction: number) => void): Promise<{ uploaded: boolean, path: string | null }>
  /** Copy an uploaded file to another spot (replacing what's there). */
  copy(from: string, to: string): Promise<string>
  /** Delete an uploaded file (a full path, or `relative` to the root); fine if it's already gone. */
  remove(path: string, relative?: boolean): Promise<void>
  /** Write a small text file (captions), replacing what's there. */
  writeText(path: string, text: string): Promise<void>
}

/**
 * A clip the old test mode marked uploaded without sending it: its path is relative (a real
 * upload's is the full Dropbox path, "/UGC/…").
 */
const fakeUploaded = (clip: { state: string, path: string | null }) => clip.state === 'uploaded' && !clip.path?.startsWith('/')

export const NO_DROPBOX = 'Dropbox isn\'t connected, so nothing was uploaded. Your clips are still on this phone: someone on the team connects Dropbox in Settings → Dropbox, then press Try again.'

/** One clip per target: a shoot item (or one beat of a VO), one clip of a b-roll shot for one channel, or one photo of a still. */
export const clipTarget = {
  item: (itemId: string, beat: string | null = null) => beat ? `item:${itemId}:${slugify(beat) || 'beat'}` : `item:${itemId}`,
  broll: (shotId: string, channelId: string | null, index: number) => `broll:${shotId}:${channelId ?? 'shared'}:${index}`,
  /** a photo for a still: a product still per channel, an avatar still per person */
  still: (shotId: string, ownerId: string, index: number) => `still:${shotId}:${ownerId}:${index}`
}

/** The clip's own extension (".mov", ".m4a"…), kept when it's renamed to its code. */
export function extensionOf(name: string, type: string) {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot > name.length - 7) return name.slice(dot).toLowerCase()
  const subtype = type.split('/')[1]?.split(';')[0]
  return subtype === 'quicktime' ? '.mov' : subtype === 'mpeg' ? '.mp3' : subtype ? `.${subtype}` : ''
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// --- on-phone storage (IndexedDB) -------------------------------------------------

interface StoredClip extends Omit<AttachedClip, 'url' | 'progress' | 'state'> {
  state: 'saved' | 'uploaded'
}

const STORE = 'clips'
let database: Promise<IDBDatabase> | null = null

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('muttiplier-clips', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'target' }).createIndex('shoot', 'shoot')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}

async function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const request = run(transaction.objectStore(STORE))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function toStored(clip: AttachedClip): StoredClip {
  // IndexedDB can't store Vue's reactive proxies
  const { url: _url, progress: _progress, state, issues, also, ...rest } = toRaw(clip)
  return { ...rest, also: also.map(spot => ({ ...spot })), issues: [...issues], state: state === 'uploaded' ? 'uploaded' : 'saved' }
}

/** Every spot a clip fills: its first, then the others. */
const spotsOf = (clip: AttachedClip): ClipSpot[] => [{ target: clip.target, dest: clip.dest }, ...clip.also]

// --- state, shared across the checklist ----------------------------------------------

/** target -> clip; a clip filling several spots is here under each of them */
const clips = shallowReactive(new Map<string, AttachedClip>())
const loadedShoots = new Set<string>()
/** each clip once, however many spots it fills */
const uniqueClips = () => [...new Set(clips.values())]

// --- shared with every phone (public.shoot_clips) ---------------------------------------
// Which deliverables have footage, and on whose phone, so nobody films one twice. Kept live
// over Supabase Realtime while the checklist is open.

export interface SharedClip {
  shootId: string
  fileName: string
  state: string
  /** who added it, i.e. whose phone it's on */
  byId: string | null
  by: string | null
  /** bytes, to spot the same file used twice */
  size: number | null
  /** its full Dropbox path once uploaded */
  path: string | null
}

/** Where a spot on the checklist sits: the shot it's for (a line by one person, or a b-roll shot) and how to name it. */
export interface ClipSpotInfo {
  shot: string
  label: string
  /** b-roll only: the format whose section it's in (null: general product shots) */
  brollFormat?: string | null
}

const shared = shallowReactive(new Map<string, SharedClip>())
/** shoot code -> id, for the shared rows */
const shootIds = new Map<string, string>()
const names = new Map<string, string>()

/** The uploads running on this phone, for the progress panel. */
const uploadRun = reactive({ active: false, shoot: '', total: 0, done: 0, failed: 0, error: '' })
/** shoots whose Dropbox folders this session has made sure of */
const treesMade = new Set<string>()
let pumping = false
let listening = false

export const useClipUpload = () => {
  const db = useDb()
  const dropbox = useDropbox()
  /** Dropbox is connected: uploads only run when it is */
  const connected = computed(() => !!dropbox.status.value?.connected)

  type SharedRow = { target: string, shoot_id: string, file_name: string, state: string, created_by: string | null, size?: number | null, path?: string | null }
  const setShared = (row: SharedRow) => shared.set(row.target, {
    shootId: row.shoot_id,
    fileName: row.file_name,
    state: row.state,
    byId: row.created_by,
    by: row.created_by ? names.get(row.created_by) ?? null : null,
    size: row.size ?? null,
    path: row.path ?? null
  })

  /** (Re)load which deliverables of a shoot have footage on any phone. */
  async function fetchShared(shoot: { code: string, id: string }) {
    const [profiles, rows] = await Promise.all([
      db.from('profiles').select('id, full_name, email'),
      db.from('shoot_clips').select('target, shoot_id, file_name, state, created_by, size, path').eq('shoot_id', shoot.id)
    ])
    for (const profile of profiles.data ?? []) names.set(profile.id, profile.full_name?.split(' ')[0] || profile.email || 'someone')
    if (rows.error) return
    for (const [target, clip] of shared) if (clip.shootId === shoot.id) shared.delete(target)
    for (const row of rows.data ?? []) setShared(row)
    // clips saved while offline get their shared rows now
    for (const clip of uniqueClips()) {
      if (clip.shoot !== shoot.code) continue
      for (const spot of spotsOf(clip)) if (!shared.has(spot.target)) share(spot.target, clip).catch(() => {})
    }
  }

  /**
   * Bring back the clips saved on this phone for a shoot (once per session), load which
   * deliverables have footage on any phone, and keep that live. `onRemoteChange` runs when
   * another phone adds, removes or uploads a clip. Returns a function to stop listening.
   */
  async function load(shoot: { code: string, id: string, revertedAt?: string | null }, onRemoteChange?: () => void) {
    // ask iOS to keep the clips rather than clear them when space runs low
    navigator.storage?.persist?.().catch(() => {})
    dropbox.ensure()
    shootIds.set(shoot.code, shoot.id)
    if (!loadedShoots.has(shoot.code)) {
      loadedShoots.add(shoot.code)
      const stored = await inStore<StoredClip[]>('readonly', store => store.index('shoot').getAll(shoot.code))
      for (const row of stored) {
        if (clips.has(row.target)) continue
        // a clip waiting to upload with no file left can't be sent: it's lost
        const state = row.state !== 'uploaded' && !row.file ? 'lost' : row.state
        const clip = reactive<AttachedClip>({ ...row, state, also: row.also ?? [], url: row.file ? URL.createObjectURL(row.file) : '', progress: row.state === 'uploaded' ? 1 : 0 })
        for (const spot of spotsOf(clip)) clips.set(spot.target, clip)
      }
    }
    await discardBefore(shoot.code, shoot.revertedAt)
    await recover(shoot.code)

    await fetchShared(shoot)
    // anything saved here that hasn't gone up yet (failed ones included) goes now
    for (const clip of uniqueClips()) if (clip.shoot === shoot.code && clip.state === 'failed' && clip.file) clip.state = 'saved'
    pump()

    const channel = db.channel(`shoot-clips-${shoot.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shoot_clips', filter: `shoot_id=eq.${shoot.id}` }, (payload) => {
        const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as Partial<SharedRow>
        if (!row.target) return
        if (payload.eventType === 'DELETE') shared.delete(row.target)
        else setShared(row as SharedRow)
        // our own changes come back too; only another phone's need the checklist reloaded
        if (!clips.has(row.target)) onRemoteChange?.()
      })
      .subscribe()
    return () => {
      db.removeChannel(channel)
    }
  }

  /** Tell every phone this spot has footage here (replacing anyone else's claim). */
  async function share(target: string, clip: AttachedClip) {
    const shootId = shootIds.get(clip.shoot)
    if (!shootId) return
    // delete + insert rather than upsert, so the row is stamped with whoever added it now
    must(await db.from('shoot_clips').delete().eq('shoot_id', shootId).eq('target', target))
    const row = must(await db.from('shoot_clips')
      .insert({ shoot_id: shootId, target, file_name: clip.name, size: clip.size, state: clip.state === 'uploaded' ? 'uploaded' : 'saved', path: clip.path })
      .select('target, shoot_id, file_name, state, created_by, size, path')
      .single())
    if (row) setShared(row)
  }

  /** Take an uploaded clip out of Dropbox: its own file and its copies in other spots. Throws if Dropbox can't be reached. */
  async function deleteUploaded(clip: AttachedClip) {
    if (clip.state !== 'uploaded' || !clip.path?.startsWith('/')) return
    const extension = extensionOf(clip.name, clip.type)
    await dropboxUploader.remove(clip.path)
    for (const spot of clip.also) {
      if (spot.path) await dropboxUploader.remove(spot.path)
      else await dropboxUploader.remove(`${spot.dest}${extension}`, true)
    }
  }

  /** Forget a clip on this phone and in the shared records, every spot it fills. */
  async function forget(clip: AttachedClip) {
    if (clip.url) URL.revokeObjectURL(clip.url)
    const targets = spotsOf(clip).map(spot => spot.target)
    for (const target of targets) {
      if (clips.get(target) === clip) clips.delete(target)
      shared.delete(target)
    }
    await inStore('readwrite', store => store.delete(clip.target))
    const shootId = shootIds.get(clip.shoot)
    if (shootId) await db.from('shoot_clips').delete().eq('shoot_id', shootId).in('target', targets)
  }

  /** The shoot was reverted: drop this phone's clips saved before then, so they're not shared or uploaded. */
  async function discardBefore(shoot: string, revertedAt?: string | null) {
    if (!revertedAt) return
    const cutoff = Date.parse(revertedAt)
    for (const clip of uniqueClips()) {
      if (clip.shoot === shoot && (clip.savedAt ?? 0) < cutoff) await forget(clip)
    }
  }

  /**
   * Clips the old test mode marked uploaded without sending: they go back to waiting for upload.
   * Its "upload" let go of the saved file, but the page still holds each clip it showed this
   * session, so while the checklist hasn't been reloaded since, they're saved on the phone again.
   * Any it can't get back are lost and have to be added again. Their shared records stop saying
   * uploaded either way.
   */
  async function recover(shoot: string) {
    for (const clip of uniqueClips()) {
      if (clip.shoot !== shoot || !fakeUploaded(clip)) continue
      if (!clip.file && clip.url) {
        clip.file = await fetch(clip.url).then(response => response.blob()).catch(() => null)
      }
      clip.path = null
      clip.progress = 0
      clip.state = clip.file ? 'saved' : 'lost'
      await inStore('readwrite', store => store.put(toStored(clip))).catch(() => {})
      const shootId = shootIds.get(clip.shoot)
      if (shootId) {
        await db.from('shoot_clips').update({ state: 'saved', path: null })
          .eq('shoot_id', shootId).in('target', spotsOf(clip).map(spot => spot.target))
      }
    }
  }

  /**
   * Remove the clip in a spot, and so from every spot the same take fills: from this phone, and
   * from Dropbox if it's been uploaded (throws, keeping it, if Dropbox can't be reached).
   */
  async function remove(target: string) {
    const clip = clips.get(target)
    if (!clip) return
    await deleteUploaded(clip)
    await forget(clip)
  }

  /**
   * Save a clip on this phone for a spot (and `also` any others the same take fills), replacing
   * what was there. Throws if the phone can't store it. `path`: a file without extension, or a
   * folder ending in `/` to keep the clip's own name.
   */
  async function save(
    target: string,
    shoot: string,
    path: string,
    file: File,
    options: { checked?: { details: string | null, issues: string[] }, also?: { target: string, path: string }[], script?: string | null, duration?: number | null } = {}
  ): Promise<AttachedClip> {
    const keepBoth = path.endsWith('/')
    const name = file.name.replace(/\.[^.]+$/, '')
    const destOf = (spot: string) => spot.endsWith('/') ? `${spot}${name}` : spot
    // replacing a take: let go of the old one in every spot it filled, and of its upload (a
    // named clip's would be overwritten anyway; b-roll keeps its own name, so it has to go)
    const spots = [target, ...(options.also ?? []).map(spot => spot.target)]
    for (const spot of spots) {
      const previous = clips.get(spot)
      if (!previous) continue
      await deleteUploaded(previous).catch(() => {})
      await forget(previous)
    }
    const clip = reactive<AttachedClip>({
      shoot,
      target,
      also: (options.also ?? []).map(spot => ({ target: spot.target, dest: destOf(spot.path) })),
      savedAt: Date.now(),
      name: file.name,
      type: file.type,
      size: file.size,
      file,
      url: '',
      dest: destOf(path),
      keepBoth,
      script: options.script ?? null,
      duration: options.duration ?? null,
      state: 'saved',
      progress: 0,
      path: null,
      details: options.checked?.details ?? null,
      issues: options.checked?.issues ?? []
    })
    await inStore('readwrite', store => store.put(toStored(clip)))
    clip.url = URL.createObjectURL(file)
    for (const spot of spotsOf(clip)) clips.set(spot.target, clip)
    // offline: the clip is still saved here, and shared the next time the checklist loads
    for (const spot of spotsOf(clip)) await share(spot.target, clip).catch(() => {})
    pump()
    return clip
  }

  async function uploadOne(clip: AttachedClip, uploader: ClipUploader) {
    if (!clip.file) return
    clip.state = 'uploading'
    clip.progress = 0
    // a clip replaced or removed mid-upload stops tracking its upload
    const current = () => clips.get(clip.target) === clip
    const extension = extensionOf(clip.name, clip.type)
    try {
      const result = await uploader.upload(clip.file, `${clip.dest}${extension}`, !!clip.keepBoth, (fraction) => {
        if (current()) clip.progress = Math.min(1, Math.max(0, fraction))
      })
      // replaced or removed while it went up: it doesn't belong in Dropbox any more
      if (!current()) {
        if (result.path) await uploader.remove(result.path).catch(() => {})
        return
      }
      if (!result.uploaded || !result.path) throw new Error('not uploaded')
      // the same take into every other channel's spot
      for (const spot of clip.also) spot.path = await uploader.copy(result.path, `${spot.dest}${extension}`)
      // no captions beside it: Klip makes them from what was said (docs/contract.md §7)
      clip.path = result.path
      clip.state = 'uploaded'
      clip.file = null // off the phone; the preview's object URL keeps it viewable this session
      await inStore('readwrite', store => store.put(toStored(clip)))
      const shootId = shootIds.get(clip.shoot)
      if (shootId) {
        for (const spot of spotsOf(clip)) {
          await db.from('shoot_clips').update({ state: 'uploaded', path: spot.target === clip.target ? clip.path : (spot as ClipSpot).path ?? null })
            .eq('shoot_id', shootId).eq('target', spot.target)
        }
      }
    } catch (error) {
      if (current()) clip.state = 'failed'
      uploadRun.error = (error as { statusMessage?: string, data?: { statusMessage?: string } }).data?.statusMessage
        ?? (error as { statusMessage?: string }).statusMessage ?? ''
    }
  }

  /** Clips on this phone waiting to go up (any shoot), oldest first. */
  const queued = () => uniqueClips().filter(clip => clip.state === 'saved' && !!clip.file)
    .sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0))

  /**
   * Send this phone's waiting clips to Dropbox, one at a time, while the app is open and online.
   * Runs by itself after every save, when the checklist opens and when the phone comes back
   * online; one that fails waits for the next of those (or Try again).
   */
  async function pump() {
    if (pumping || !queued().length) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    pumping = true
    let wakeLock: { release: () => Promise<void> } | null = null
    try {
      // only ever to Dropbox: without it nothing is touched, and the clips stay on the phone
      if (!connected.value) {
        const status = await dropbox.refresh().catch(() => null)
        if (!status?.connected) {
          uploadRun.error = status ? NO_DROPBOX : 'Couldn\'t reach Kreate to check Dropbox, so nothing was uploaded yet. Your clips are still on this phone and go up once there\'s a connection.'
          return
        }
      }
      Object.assign(uploadRun, { active: true, done: 0, failed: 0, error: '' })
      try {
        wakeLock = await (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } })
          .wakeLock?.request('screen') ?? null
      } catch { /* the screen may sleep, which pauses the upload until the app is back */ }
      for (let clip = queued()[0]; clip; clip = queued()[0]) {
        uploadRun.shoot = clip.shoot
        uploadRun.total = uploadRun.done + queued().length
        // make sure the shoot's folder tree is there (only what's missing is added); uploads
        // create their own folders anyway, so a failure here doesn't stop them
        if (!treesMade.has(clip.shoot)) {
          treesMade.add(clip.shoot)
          await $fetch('/api/dropbox/tree', { method: 'POST', body: { shootCode: clip.shoot } }).catch(() => {})
        }
        await uploadOne(clip, dropboxUploader)
        if (clip.state === 'failed') uploadRun.failed++
        uploadRun.done++
      }
    } finally {
      pumping = false
      uploadRun.active = false
      wakeLock?.release().catch(() => {})
    }
  }

  /** Send a shoot's clips still on this phone, failed ones included (Try again, or every phone's Upload). */
  async function uploadShoot(shoot: string) {
    await recover(shoot)
    for (const clip of uniqueClips()) if (clip.shoot === shoot && clip.state === 'failed' && clip.file) clip.state = 'saved'
    await pump()
  }

  // back online: try again what didn't go through
  if (import.meta.client && !listening) {
    listening = true
    window.addEventListener('online', () => {
      for (const clip of uniqueClips()) if (clip.state === 'failed' && clip.file) clip.state = 'saved'
      pump()
    })
  }

  /**
   * The same file (name and size) already used for a different shot on this shoot, on any
   * phone: usually a mix-up. `spots` are the ones this take is for (its copies on the person's
   * other channels are the same take, not a duplicate); `spotInfo` places a target on the shoot.
   */
  function duplicateOf(
    shoot: string,
    file: { name: string, size: number },
    spots: string[],
    spotInfo: (target: string) => ClipSpotInfo | null
  ): { label: string, by: string | null } | null {
    const shootId = shootIds.get(shoot)
    const mineInfo = spotInfo(spots[0]!)
    const mine = mineInfo?.shot
    const candidates: { target: string, name: string, size: number | null, by: string | null }[] = [
      ...[...clips.entries()].filter(([, clip]) => clip.shoot === shoot).map(([target, clip]) => ({ target, name: clip.name, size: clip.size, by: null })),
      ...[...shared.entries()].filter(([target, clip]) => clip.shootId === shootId && !clips.has(target))
        .map(([target, clip]) => ({ target, name: clip.fileName, size: clip.size, by: clip.by }))
    ]
    for (const other of candidates) {
      if (spots.includes(other.target) || other.name !== file.name || (other.size !== null && other.size !== file.size)) continue
      const info = spotInfo(other.target)
      if (info && info.shot === mine) continue
      // b-roll in two different formats' sections never lands in the same video, so reusing a clip
      // there is fine; general product shots go under any VO, so they still count
      if (mineInfo?.brollFormat && info?.brollFormat && mineInfo.brollFormat !== info.brollFormat) continue
      return { label: info?.label ?? 'another shot', by: other.by }
    }
    return null
  }

  /** Each phone's clips for a shoot (by whoever added them), for the upload progress. */
  function phones(shootId: string) {
    const byPhone = new Map<string, { name: string, total: number, uploaded: number }>()
    for (const clip of shared.values()) {
      if (clip.shootId !== shootId) continue
      const key = clip.byId ?? 'unknown'
      const phone = byPhone.get(key) ?? { name: clip.by ?? 'Someone', total: 0, uploaded: 0 }
      phone.total++
      if (clip.state === 'uploaded') phone.uploaded++
      byPhone.set(key, phone)
    }
    return [...byPhone.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Clips of a shoot on this phone still to upload. */
  const waiting = (shoot: string) => uniqueClips().filter(clip => clip.shoot === shoot && clip.state !== 'uploaded' && clip.state !== 'lost')
  /** Clips of a shoot that never reached Dropbox and aren't on this phone any more: add them again. */
  const lost = (shoot: string) => uniqueClips().filter(clip => clip.shoot === shoot && clip.state === 'lost')

  return {
    connected,
    clipFor: (target: string) => clips.get(target) ?? null,
    /** a clip added on another phone for this target, if there's none on this one */
    elsewhere: (target: string) => clips.has(target) ? null : shared.get(target) ?? null,
    /** whether a target has footage on any phone (this one included) */
    taken: (target: string) => clips.has(target) || shared.has(target),
    duplicateOf,
    load,
    discardBefore,
    resync: fetchShared,
    phones,
    save,
    remove,
    uploadShoot,
    waiting,
    lost,
    recover,
    uploadRun: readonly(uploadRun)
  }
}
