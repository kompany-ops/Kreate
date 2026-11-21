# Kreate ↔ Kanvas contract

contract_version: 1

The agreement between **Kreate** (which decides which static ads exist) and **Kanvas** (which prepares assets and renders them). This file is identical in both repos: Kreate's `docs/contract-kanvas.md` and Kanvas's `docs/contract.md`, each with the example index beside it (`contract-kanvas/_kanvas.example.json` here, `contract/_kanvas.example.json` there). It works like the Kreate ↔ Klip contract (`docs/contract.md`) and sits beside it: Klip edits a shoot's video, Kanvas makes its static ads, and they share the shoot folder.

## 1. Who does what

| Tool | Reads | Writes | Decides |
|---|---|---|---|
| **Kreate** | `edited/_kanvas.json` | `manifest.json` (`plan.static`, `static_assets`), `statics.json`, `batches/SB##.json`, `raw/…/stills/` (photos from the checklist) | which static formats, variants, copy and wordings exist; which static recipes exist; what each flag means |
| **Kanvas, prep** | `manifest.json`, `raw/`, `edited/` (Klip's takes, for frames) | cut-outs and frames in `edited/`, `<root>/_kanvas/plates/`, `edited/_kanvas.json` | how assets are cut out; which frames make good avatars |
| **Kanvas, render** | `statics.json`, `batches/SB##.json`, `edited/`, `_kanvas.json` | `renders/SB##/…`, `edited/_kanvas.json` | how each ad looks; nothing about which ads exist |

Kanvas has no rules of its own about which ads to make, and Kreate never reads Kanvas's images except to show them for review.

## 2. Folders

Additions to Kreate's folder tree (spec §10d), relative to the Dropbox `UGC/` root:

```
UGC/
  _kanvas/plates/<format code>/<reference hash>.png     plates, per format, shared by every shoot
  [brand]/_kit/                                         the brand kit's files in Dropbox: logo/, fonts/, packshots/
  [brand]/[product]/shoots/[S###]/
    raw/[channel]/stills/product/<photo>                product stills, loose (like b-roll)
    raw/[channel]/stills/avatar/[person]/<photo>        avatar stills per person, under the first of their channels on the shoot
    edited/[channel]/stills/…                           <photo>.cutout.png, frame-<take>-<n>.png
    edited/_kanvas.json                                 Kanvas's index (§5)
    statics.json                                        every valid static recipe, grouped by channel (§4)
    batches/SB01.json, SB01.csv                         static batches (§6)
    renders/SB01/[channel]/[recipe id].<size>.png       e.g. ….4x5.png; sizes 1x1, 4x5, 9x16
```

Kreate makes the shoot's still folders and the brand's `_kit/` folders when it builds the shoot's folders. Packshots go in `_kit/packshots/` by hand.

## 3. The static plan (`manifest.json` → `plan.static`)

Present when the shoot has static formats; absent otherwise. It's written when the shoot is planned and again when it's sent for editing (the plan Kanvas preps from), and in every Live manifest. `plan_hash` covers it (without the signed links), so Kanvas copies the manifest's `plan_hash` into its index as Klip does.

```ts
interface PlanStatic {
  wording_variations: number            // extra recipes per copy from mixing its slots' other wordings
  formats: {
    code: string                        // "SF03"
    name: string
    description: string | null          // what it is
    mechanism: string | null            // why it works
    slots: { key: string, label: string, max_words: number | null, guidance: string | null, example: string | null, required: boolean }[]
    variants: ('text' | 'text_product' | 'text_avatar' | 'text_product_avatar')[]
    rules: { always: string[], never: string[] }
    references: { path: string, source_url: string | null, url?: string }[]   // example ads; url: a signed link, valid 30 days
    plate: boolean                      // work from a blank plate of the reference
    text_render: 'ai' | 'overlay'       // the image model writes the copy, or Kanvas sets it in type
    sizes: ('1x1' | '4x5' | '9x16')[]
  }[]
  brand_kit: {                          // null: no kit; take the look from the references and the stills
    colors: { name: string, hex: string }[]
    fonts: { role: 'headline' | 'body', family: string, file: string | null, url?: string }[]   // a file only for overlay formats
    logos: { path: string, use: 'light' | 'dark' | 'mark', url?: string }[]
    style_notes: string | null
    rules: { always: string[], never: string[] }   // on top of every format's
    dropbox_path: string | null         // the brand's _kit/ folder (packshots in packshots/)
  } | null
  copies: {
    code: string                        // "A02"
    format: string                      // its static format's code
    channel: string | null              // the channel it's for; null: every channel on the shoot
    feature: string | null              // the product feature it's about
    slots: { slot: string, text: string, alternates: { text: string }[] }[]   // as written
    filled: Record<string, { slot: string, text: string, alternates: string[] }[]>   // per channel slug, slots filled
  }[]
  stills: { id: string, kind: 'product' | 'avatar', description: string, count: number, feature: string | null }[]
}
```

A Live manifest also has `static_assets`: each still's photos as filed, relative to the shoot folder.

```ts
static_assets: { product: Record<string /* channel */, string[]>, avatar: Record<string /* person */, string[]> }
```

## 4. `statics.json` (Kreate writes, when the shoot goes Live)

```ts
interface StaticsFile {
  schema_version: 1
  shoot: string
  manifest_version: number
  generated_at: string
  plan_hash: string | null
  channels: Record<string, StaticRecipe[]>
}

interface StaticRecipe {
  id: string                    // "S001_topdognix_SF03.text_product_A02.1.2_<hash of asset picks>";
                                // person variants add the person: "S001_topdognix_joe_SF03.text_avatar_A02_<hash>"
  channel: string
  person: string | null         // the avatar; null on text and text_product
  format: string                // static format code, "SF03"
  variant: 'text' | 'text_product' | 'text_avatar' | 'text_product_avatar'
  copy: { code: string, wordings: number[],          // "A02", which wording of each slot (1 = the first)
          slots: Record<string, string> }            // slot key → final text, slots filled
  assets: { product?: string[], avatar?: string[] }  // picks, relative to the shoot folder
  sizes: ('1x1' | '4x5' | '9x16')[]
}
```

- **Which recipes exist** (Kreate's rules): one format, one variant, one copy (one wording of each slot), for one channel. `text` is always made. `text_product` is always made: with one of the channel's product stills when there are any, rotated across recipes; with none, `assets.product` is missing and Kanvas draws the product (flag it `generated_product`). Person variants are made once per person on the channel who has an avatar still, or else a filmed hook or CTA (their first wordings); `assets.avatar` is a still in `raw/` or a take in `edited/` to take a frame from.
- **Asset paths** are relative to the shoot folder: `raw/…/stills/…` for photos as filmed, `edited/…` for takes. Kanvas maps a photo to its own cut-out (in `edited/`, listed in its index) when it renders.
- The format's definition and the brand kit are in `manifest.json` → `plan.static`: a recipe only names them.
- Same inputs, same IDs. Recipes are fixed once Live; batches name them by ID.

## 5. `edited/_kanvas.json` (Kanvas writes)

```ts
interface KanvasIndex {
  schema_version: 1             // this contract's version
  kanvas_version: string
  plan_hash: string             // the manifest's plan_hash Kanvas worked from
  shoot: string
  updated_at: string
  assets: { file: string, kind: 'cutout' | 'frame', of: string, person?: string }[]   // file and of: relative to the shoot folder
  renders: {
    recipe: string
    batch: string               // "SB01"
    status: 'rendered' | 'failed'
    files: Partial<Record<'1x1' | '4x5' | '9x16', string | null>>   // relative to the shoot folder
    product: 'from_still' | 'generated' | 'none'
    flags: { code: 'generated_product' | 'text_mismatch' | 'rule_breach' | 'composition', size?: string, note: string }[]
    attempts: number
    model: string
  }[]
}
```

Kanvas rewrites the whole file each time; renders from every static batch stay in it.

## 6. Static batches (Kreate writes)

`batches/SB01.json`:

```ts
{ schema_version: 1, shoot: string, batch: 'SB01', medium: 'static', manifest_version: number, generated_at: string,
  pick: { exploit: number, explore: number }, statics_file: 'statics.json', renders_folder: 'renders/SB01', recipes: string[] }
```

and `batches/SB01.csv` for people. Kanvas renders each recipe into `renders/SB01/<channel>/<recipe id>.<size>.png`, in every size its recipe lists.

## 7. What Kreate does with the index

- **Review before submitting.** A static batch reads `_kanvas.json` and shows each of its ads with its sizes and flags. `generated_product` **blocks**: the ad must be approved or rejected before the batch can be marked Submitted; a rejected ad is left out of the submission and its recipe can be batched again. `text_mismatch`, `rule_breach` and `composition` are warnings beside the ad and never block.
- Kreate refuses an index with a `schema_version` it doesn't know, or one that isn't valid, with a clear message, rather than guessing. An index for another `plan_hash` is shown with a warning: the plan changed after Kanvas ran.

## 8. Changing this contract

- The `contract_version` line at the top changes with every change. Both copies of this file and the example change together.
- Kreate's tests check its copy has the same `contract_version` as the example's `schema_version` and as Kanvas's copy where it can see it (`../Kanvas/docs/contract.md`), and read the example the way this file says.

## 9. Decisions

- **Assets relative to the shoot folder** (2026-11-20): recipes name photos as filmed in `raw/` (or takes in `edited/`); Kanvas maps them to its cut-outs, so Kreate builds recipes without waiting for Kanvas's prep.
- **Avatar stills under one channel** (2026-11-20): a person's avatar stills are filed under the first of their channels on the shoot (by name) and used on all of them.
- **Scores**: static batches are scored apart from video's. Elements are the static format, the variant, the copy (with its wordings) and the person in a person variant, kept as `avatar` so it never mixes with video's `person`.
