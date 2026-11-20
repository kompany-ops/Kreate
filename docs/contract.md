# Kreate ↔ Klip contract

contract_version: 3

Agreed 2026-11-15 · reviewed by Kreate (kreate-47), decisions by Joe · not yet implemented on either side

This is the agreement between the two tools about the files they share in a shoot folder. Each tool keeps its own spec (Kreate `docs/spec.md` §12b, Klip `spec.md`); where they disagree with this document, this document wins and the spec gets fixed. A copy lives in both repos, identical, with the example index in [contract/_klip.example.json](contract/_klip.example.json); see §9.

## 1. Who does what

| Tool | Reads | Writes | Decides |
|---|---|---|---|
| **Kreate** | `edited/_klip.json` | `manifest.json`, `recipes.json`, `batches/*.json`, `raw/` (uploads) | what was filmed, which treatments are on, which recipes exist and which treatments apply to each |
| **Klip, edit** (`klip shoot`) | `manifest.json` (the plan), `raw/` | `edited/` (building blocks), `edited/_klip.json`, `edited/_review.md` | how each take is cut, captioned and cut out; the text a treatment needs |
| **Klip, render** (ex-Showdog) | `recipes.json`, `batches/*.json`, `edited/`, `edited/_klip.json`, the design system | `renders/<batch>/…` | nothing: it composes exactly what the recipe and its treatment say |

Klip never decides which recipes or treated versions exist. Kreate never inspects `edited/` media: everything it needs about an edit comes from `_klip.json`. (It still measures raw clips on the phone at upload.)

## 2. Change from today

Today each treatment gets a **treated copy** of every take it applies to (`H01.search-bar.mp4`), and a treated recipe swaps its files for those copies. That goes away.

Instead Klip makes a small, fixed set of **building blocks** per take, and the renderer composes every treatment from them at render time. A treated recipe keeps pointing at the takes themselves; its `treatment` tells the renderer which blocks to use and how.

Why: combinations need no extra files, a design tweak (box size, caption position, search bar look) needs a re-render instead of a re-edit, the retro look can cover the b-roll too, and Klip makes and uploads only what's expensive (an edit, captions, a cut-out, AI text).

## 3. Takes and their roles

Every filmed take is filmed on camera, VO beats included. A VO beat shown as `screen` (text on a phone screen) is not filmed: it has no take, no spot and no files, and Klip never looks for one.

Klip finds the takes from `manifest.json` → `plan.items`, at the spot Kreate's `takeSpot()` gives, relative to `raw/` and `edited/`:

- hook: `<channel>/hooks/<person>/<code>`; its other wordings (the plan item's `alternates`, each with its `option`) are `<code>-<option>` beside it
- CTA: `<channel>/ctas/<person>/<code>`; its other wordings likewise `<code>-<option>`
- VO beat: `<channel>/vo/<person>/<beat folder>/<code>`, where the beat folder is `slugify(beat name)`; wordings 2+ are `<code>-<option>`

Each take's **role** sets the editing rules Klip applies (length, camera move, sound effect, captions):

| Take | Role |
|---|---|
| a hook item (every wording) | `hook` |
| a CTA item (every wording) | `cta` |
| a standalone VO's beat named `hook` | `hook` |
| a standalone VO's beat named `cta` | `cta` |
| any other VO beat shown `face`, `broll` or `voice_note` | `beat` |

The role comes from the plan, never from the folder name (this matches Kreate's `sidecarClipOf()`).

Files in `raw/`:

- A raw media file at a take's spot (any extension) is that take.
- **Two or more** media files at one spot: Klip edits neither and lists each under `unknown` with reason `duplicate`.
- A raw media file under `<channel>/b-roll/…` is b-roll. Its folder path (`<channel>/b-roll/<beat>[/<feature>]` or `…/general`) is kept unchanged in `edited/`; only the extension changes.
- Any other media file is listed under `unknown` with reason `no spot` and not edited.
- Non-media files (`.srt` and the like) are ignored.

## 4. Building blocks

All in `edited/`, at the take's spot. `<spot>` is the path without extension.

| Block | File | What it is | Made for |
|---|---|---|---|
| `clip` | `<spot>.mp4` | The edited take: trimmed, camera move baked in, voice and sound effects mixed and loudness-normalised. **No captions burned in.** H.264 + AAC, 1080×1920. | every take, always |
| `captions` | `<spot>.captions.webm` | The take's captions alone on transparency. No person, no audio. VP9 with alpha. | every take, always |
| `cutout` | `<spot>.cutout.webm` | The speaker alone, background removed, full frame, in place. No audio. VP9 with alpha. | takes in scope of a treatment that needs it |
| `captions-retro` | `<spot>.captions-retro.webm` | The captions in the retro look's throwback style. | takes in scope of a treatment that needs it |
| b-roll | `<same path>.mp4` | Graded, trimmed, muted. | every b-roll clip |

Rules:

- `captions`, `cutout` and `captions-retro` have exactly the `clip`'s length and frame rate, frame for frame, so they can be laid over it (or over anything of the same length) without retiming.
- Picture-in-picture needs no block: the renderer scales the `clip` into the box.
- The block names (`captions`, `cutout`, `captions-retro`) are reserved: Kreate never counts `<spot>.<block>.<ext>` as a clip. New blocks come with a contract version bump.
- B-roll gets no blocks.

## 5. Which blocks a shoot needs

Treatments are identified by their **`component`**, never by name (teams name their own). Each component's **ingredients** are fixed by this contract:

| `component` | What the renderer draws | Ingredients |
|---|---|---|
| `layout` | `settings.show`: `face` (every VO beat on camera) or `broll` (every VO beat over b-roll) | — |
| `search_bar` | a search bar typing the query, then the take | `search_query` |
| `placed_text` | the hook line as large text at a chosen spot, instead of captions | `placed_text` |
| `retro_look` | the throwback look over the whole joined video | `captions-retro` |
| `greenscreen` | the cut-out speaker over a backdrop | `cutout` |
| `picture_in_picture` | the `clip` in a corner box over b-roll | — |
| `combo` | its `parts`, each on its own section of the video | the union of its parts' |

These are the **only** components the renderer supports. Kreate treats any other component (including the archived `text_thread`, `then_now_labels`, `offer_badge`) as "can't be drawn": it doesn't offer it and makes no versions for it. A new component comes with a contract version bump.

A treatment's **scope** is the takes it covers, from its `placement`: `hook` = takes with role `hook`, `cta` = role `cta`, `video` = every take. A combination's ingredients are its parts' ingredients, each over its own part's scope.

Klip makes the union over the shoot: for each treatment in `manifest.json` → `plan.treatments`, every ingredient for every take in its scope. A shoot with only the two built-in layouts gets `clip` and `captions` and nothing else.

`settings` choose between variants the renderer supports (which corner, which backdrop, top or bottom). How each variant looks (sizes, fonts, colours, animation) is the design system's. Supported settings:

| `component` | Setting | Values |
|---|---|---|
| `layout` | `show` | `face`, `broll` |
| `search_bar` | `position` | `top`, `bottom` |
| `greenscreen` | `background` | `broll` (`product_page` once Kreate has product images; until then it's treated as `broll`) |
| `picture_in_picture` | `corner` | `bottom-right`, `bottom-left`, `top-right`, `top-left` |

## 6. `edited/_klip.json`

Klip's index of everything it made. Written after every take, atomically (write `_klip.json.partial`, then rename), so it is always valid and always current. Paths are relative to `edited/` (the same base as Kreate's manifest), forward slashes. Example: [contract/_klip.example.json](contract/_klip.example.json).

```ts
interface KlipIndex {
  /** always this document's contract_version */
  schema_version: 3
  /** Klip's own version, for support */
  klip_version: string
  /** the manifest's `plan_hash` Klip worked from (§7) */
  plan_hash: string
  shoot: string                       // "S001"
  updated_at: string                  // ISO 8601
  /** true when every take and b-roll clip in raw/ is edited or failed and every ingredient is made */
  complete: boolean
  takes: KlipTake[]
  broll: KlipBroll[]
  /** raw media files Klip didn't edit, and why */
  unknown: { raw_file: string; reason: 'duplicate' | 'no spot' }[]
}

interface KlipTake {
  spot: string                        // "wellbymak/vo/makayla/hook/V01"
  raw_file: string                    // relative to raw/
  role: 'hook' | 'cta' | 'beat'
  status: 'edited' | 'failed'
  /** null until made; a block this shoot doesn't need is absent */
  files: {
    clip: string | null
    captions: string | null
    cutout?: string | null
    'captions-retro'?: string | null
  }
  /** seconds and frames of the clip (the blocks match it) */
  duration: number | null
  frames: number | null
  fps: number | null
  /** text ingredients; absent when not needed */
  text?: {
    /** search_bar: the query typed, as a viewer would search it */
    search_query?: string
    /** placed_text: the line shown and where (0–1 of the frame, the text's centre) */
    placed_text?: { text: string; x: number; y: number }
  }
  /** a human should look at it; never blocks going Live (§7) */
  review: { needed: boolean; reasons: string[]; notes: string[] }
}

interface KlipBroll {
  file: string | null                 // "wellbymak/b-roll/problem/IMG_7687.mp4"
  raw_file: string
  status: 'edited' | 'failed'
  duration: number | null
  frames: number | null
  fps: number | null
}
```

`edited/_review.md` stays, for people. `_klip.json` is for tools.

## 7. What Kreate does with it

**Plan hash.** Every manifest Kreate writes carries `plan_hash`: a hash of `plan`, which is frozen once the shoot is planned. (`version` doesn't work for this: the plan manifest Klip reads is always `version: 0`, and real versions only exist once the shoot is Live.) Klip copies `plan_hash` into `_klip.json`.

**Check edits** reads `_klip.json` instead of listing and measuring media. It reports a problem when:

- `_klip.json` is missing, its `schema_version` is one Kreate doesn't know, or its `plan_hash` isn't the current manifest's;
- a filmed take's spot isn't in `takes`, or its `status` is `failed`;
- a take's `clip` or `captions` is null, or the file isn't in the `edited/` listing;
- a treatment that's on is missing an ingredient for a take in its scope (named by treatment, as now);
- a raw media file isn't in `takes` or `broll` (still being edited), or is in `unknown` (naming the reason: duplicate files at a spot, or a file at no spot).

`review.needed` is a warning shown beside the take. It never blocks going Live.

Lengths come from `duration` in the index.

**Other wordings** (version 3): a hook or CTA in the plan can carry `alternates`, its other wordings, each a take of its own at `<code>-<option>` (§3) with the hook's or CTA's role. In the manifest each is a take clip with `option` 2, 3…; in `recipes.json` (version 4) `hook.option` and `cta.option` say which wording a recipe uses, and recipe IDs name it `<code>-<option>`. The index is unchanged, so Kreate still reads a version 2 index: a Klip that old leaves those takes unedited, and Check edits reports them (at no spot).

**The manifest** (`TakeClip`): `file` is the `clip` block. `caption` and `sidecars` are replaced by `blocks` (the `files` map minus `clip`) and `text`. `MANIFEST_SCHEMA_VERSION` goes to 11.

**Treatments in the plan**: `sidecar` and `applies_to` go. Kreate derives ingredients from `component` (§5).

**Recipes** (`recipes.json`):

- `hook.caption`, `cta.caption` and `vo_captions` (today the `.srt` paths) are replaced by each take's `blocks` and `text`, so the renderer reads them from the recipe.
- A treated recipe keeps the untreated recipe's files (no swapping; `withSidecars` goes). It is made only when every take in the treatment's scope has the treatment's ingredients.
- The recipe's `treatment` object drops `sidecar` and `applies_to`.

**Uploads**: Kreate stops writing `<spot>.srt` beside raw clips (`useClipUpload.ts`).

## 8. What the renderer composes

Captions are always laid on last, over whatever picture plays, unless the treatment hides them.

| Version | Picture under each part | Captions |
|---|---|---|
| untreated / `layout` face | face beat: `clip`; b-roll beat: b-roll (sound from `clip`) | `captions` |
| `layout` broll | every VO beat over b-roll | `captions` |
| `picture_in_picture` | b-roll, with `clip` scaled into the corner box | `captions`, kept clear of the box |
| `greenscreen` | backdrop (b-roll), with `cutout` placed by the design system | `captions` |
| `search_bar` | the hook opens on the search bar typing `search_query`, then plays as usual | `captions` after the search bar |
| `placed_text` | hook as usual | hook: none; `placed_text` drawn at its position. Rest: `captions` |
| `retro_look` | as untreated, then the look over the whole joined video, b-roll included | `captions-retro` |
| `combo` | each part on its own section: hook-placed parts on the hook, the layout on the body | as its parts |
| `voice_note` beat | not drawn yet: the renderer fails the recipe with a clear message | — |

## 9. Changing this contract

- The `contract_version` line at the top changes with every change. Both copies of this file and the example change together.
- Each repo has a test that:
  - checks its copy of this file has the same `contract_version` as the example's `schema_version` and the other repo's copy where it can see it;
  - loads `contract/_klip.example.json`: Klip checks it against the type it writes; Kreate parses it with its zod schema and runs Check edits and the manifest builder on it.
- Kreate refuses an index with a `schema_version` it doesn't know, with a clear message, rather than guessing.

## 10. Decisions

- **Cut-out scope** (Joe, 2026-11-15): scope follows `placement` for every treatment, footage included. Greenscreen (`placement: video`) gets a cut-out of every take: hooks, CTAs and VO beats. Kreate's `sidecarClips()` rule limiting footage treatments to VO takes goes.
- **Product-page backdrop** (Joe, 2026-11-15): greenscreen uses b-roll for now. `product_page` waits for a product image upload in Kreate.
- **Retro captions**: a second captions block, which keeps Klip's emphasis and corrections.
- **Master copy**: identical copies in both repos plus the shared example, with drift tests.
- **Hook and CTA wordings** (Joe, 2026-11-20, version 3): a hook or CTA can have more than one wording on a shoot, each filmed as its own take at `<code>-<option>`, mixed into recipes up to the shoot's wording mixes and scored as one hook or CTA.

No open questions.
