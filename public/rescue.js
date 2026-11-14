// One-off rescue for clips the old "test mode" never uploaded (removed in Nov 2026). Loaded by a
// bookmarklet in the Kreate tab that still holds them in memory:
//   javascript:void import('/rescue.js?'+Date.now())
// It finds every clip card's in-memory copy, uploads it to Dropbox where the real upload would
// have put it, and records on the phone that it's uploaded. Progress shows on screen. Safe to run
// again: it skips what it already sent. Delete this file once nobody needs it.

const panel = document.createElement('div')
panel.style.cssText = 'position:fixed;inset:auto 8px 8px 8px;max-height:60vh;overflow:auto;z-index:99999;background:#111;color:#eee;font:13px/1.4 -apple-system,system-ui,sans-serif;padding:12px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);white-space:pre-wrap'
const close = document.createElement('button')
close.textContent = 'Close'
close.style.cssText = 'float:right;background:#333;color:#fff;border:0;border-radius:8px;padding:4px 10px;font:inherit'
close.onclick = () => panel.remove()
const lines = document.createElement('div')
panel.append(close, lines)
document.body.append(panel)
const say = (text, color = '#eee') => {
  const line = document.createElement('div')
  line.textContent = text
  line.style.color = color
  lines.append(line)
  panel.scrollTop = panel.scrollHeight
}

try {
  window.__rescued ??= new Set()
  say('Kreate clip rescue')

  // every clip card's state (Vue), with its in-memory copy (a blob: URL)
  const app = document.querySelector('#__nuxt')?.__vue_app__
  if (!app) throw new Error('This isn\'t the Kreate checklist page.')
  const clips = new Map()
  const keep = (clip) => {
    if (clip && clip.url && clip.dest && !clips.has(clip.url)) clips.set(clip.url, clip)
  }
  // the checklist page's own tools: clipFor(target) finds any clip in this tab, shown or not
  let clipFor = null
  let db = null
  let shootId = null
  const visit = (vnode, depth = 0) => {
    if (!vnode || depth > 500) return
    const component = vnode.component
    if (component) {
      const state = component.setupState || {}
      keep(state.clip)
      if (typeof state.clipFor === 'function') clipFor ??= state.clipFor
      if (state.db && typeof state.db.from === 'function' && state.shoot?.id) {
        db ??= state.db
        shootId ??= state.shoot.id
      }
      visit(component.subTree, depth + 1)
    }
    if (vnode.suspense) visit(vnode.suspense.activeBranch, depth + 1)
    if (Array.isArray(vnode.children)) for (const child of vnode.children) if (child && typeof child === 'object') visit(child, depth + 1)
  }
  visit(app._instance.subTree)
  // every spot on the shoot that has a clip (any phone), looked up in this tab
  if (clipFor && db && shootId) {
    const { data, error } = await db.from('shoot_clips').select('target').eq('shoot_id', shootId)
    if (error) say(`Couldn't list the shoot's clips (${error.message}); using the ones on screen.`, '#fc6')
    for (const row of data || []) keep(clipFor(row.target))
  } else {
    say('Using the clips on screen only.', '#fc6')
  }
  const todo = [...clips.values()].filter(clip => !(clip.path || '').startsWith('/') && !window.__rescued.has(clip.url))
  say(`Found ${clips.size} clips in this tab. ${todo.length} to upload.`)
  if (!todo.length) {
    say(window.__rescued.size ? `Already rescued ${window.__rescued.size} in this tab.` : 'None found in this tab. It may have been reloaded since the shoot, which clears them.', '#fc6')
  } else {
    const access = await fetch('/api/dropbox/token', { method: 'POST' }).then(async (response) => {
      if (!response.ok) throw new Error(`Couldn't get Dropbox access (${response.status}): ${await response.text()}`)
      return response.json()
    })
    const ascii = value => JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    const extension = (name, type) => {
      const dot = name.lastIndexOf('.')
      if (dot > 0 && dot > name.length - 7) return name.slice(dot).toLowerCase()
      const subtype = (type || '').split('/')[1]?.split(';')[0]
      return subtype === 'quicktime' ? '.mov' : subtype ? `.${subtype}` : ''
    }
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('muttiplier-clips', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const markUploaded = (target, path) => new Promise((resolve) => {
      const store = database.transaction('clips', 'readwrite').objectStore('clips')
      const get = store.get(target)
      get.onsuccess = () => {
        if (get.result) store.put({ ...get.result, path, state: 'uploaded' })
        resolve()
      }
      get.onerror = () => resolve()
    })

    let sent = 0
    const failed = []
    for (const clip of todo) {
      try {
        const blob = await fetch(clip.url).then(response => response.blob())
        const ext = extension(clip.name, clip.type)
        const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${access.accessToken}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': ascii({ path: `${access.root}/${clip.dest}${ext}`, mode: clip.keepBoth ? 'add' : 'overwrite', autorename: !!clip.keepBoth, mute: true })
          },
          body: blob
        })
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
        const uploaded = await response.json()
        // the same take in the person's other channels' spots
        for (const spot of clip.also || []) {
          await fetch('https://api.dropboxapi.com/2/files/copy_v2', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${access.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from_path: uploaded.path_display, to_path: `${access.root}/${spot.dest}${ext}`, autorename: false })
          })
        }
        await markUploaded(clip.target, uploaded.path_display)
        window.__rescued.add(clip.url)
        sent++
        say(`✓ ${sent}/${todo.length} ${clip.dest.split('/').slice(-3).join('/')}${ext}`, '#6f6')
      } catch (error) {
        failed.push(clip.name)
        say(`✗ ${clip.name}: ${error.message}`, '#f66')
      }
    }
    say(`Done: ${sent} uploaded to Dropbox${failed.length ? `, ${failed.length} failed. Tap the bookmark again to retry them.` : '.'}`, failed.length ? '#fc6' : '#6f6')
    say(`In total this tab has rescued ${window.__rescued.size}. Keep it open and tell Claude.`)
  }
} catch (error) {
  say(`Stopped: ${error.message}`, '#f66')
}
