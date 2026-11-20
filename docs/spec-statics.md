# Kreate — Statics Spec

Adds **static ads** to Kreate: a Library of static formats, a design kit per brand, stills on the shoot checklist, static copy written per shoot, static recipes and static batches. Kanvas makes the ads; Kreate decides what gets made, as it does with Klip. This document adds to [spec.md](spec.md); section numbers in brackets point into it. When this is built, fold it into spec.md.

*Draft, 2026-11-20. Nothing built yet.*

---

## 1. Principles

- **Same split as Klip.** Kreate holds the Library, the plan, the copy, the recipes and the batch loop. Kanvas prepares assets and renders, with no rules of its own. The agreement is a contract file copied into both repos (Kanvas `spec.md` §11, to become `docs/contract-kanvas.md` here and `docs/contract.md` there), with drift tests [§12b, contract §9].
- **Still no built-in AI** [§11]. People draft formats and copy with their own AI through the AI connector (§9); Kanvas uses its own AI to make the ads.
- **Agnostic Library.** Static formats are brand-agnostic templates, like hooks and CTAs; copy is written per shoot for its product, like VOs.
- **Parity.** Everything a person can do to a static format or copy in the app, the connector can do, through the same shared code and database rules.

---

## 2. Static formats (Library → **Statics** tab)

A static format is a reusable structure for a static ad, such as Notes app, Offer-first banner or Mirror note.

**static_formats**
- `code text unique` (`SF01`, `SF02`, …), `name text`, `description text` (what it is), `mechanism text` (why it works)
- `slots jsonb`: ordered `[{ "key": "headline", "label": "Headline", "max_words": 8, "guidance": "...", "example": "...", "required": true }]`. Slot keys are lowercase snake case and unique within a format.
- `variants text[]`: which of `text`, `text_product`, `text_avatar`, `text_product_avatar` the format supports (at least one)
- `rules jsonb`: `{ "always": ["..."], "never": ["..."] }`
- `references`: one or more example ads, in the `static-references` storage bucket (`<org id>/<format id>/<n>.<ext>`), each with an optional `source_url` (e.g. a Meta Ad Library link)
- `plate boolean default false`: Kanvas works from a blank plate of the reference
- `text_render text check (text_render in ('ai','overlay')) default 'ai'`
- `sizes text[] default '{4x5,1x1,9x16}'`
- `tags text[]`, `notes text`, `archived boolean`

Variants work like treatments: each has fixed **ingredients**, and a static recipe is made only when they're there (§6):

| Variant | Shows | Ingredients |
|---|---|---|
| `text` | copy only | — |
| `text_product` | copy and the product | a product still, a brand packshot, or none (Kanvas then draws the product, flagged for approval, §7) |
| `text_avatar` | copy and a person | an avatar still of that person, or a filmed hook or CTA take of theirs (Kanvas grabs a frame) |
| `text_product_avatar` | copy, the product and a person | both of the above |

**UI** (as the other Library tabs [§7]):
- List with search, filters (variant, tags, archived) and sort; each row shows the first reference as a thumbnail and "used in N shoots".
- **New format** opens a blank editor; **From an example ad** asks for an image (PNG, JPG, PDF or a flattened PSD/Figma/Canva export) and opens the editor beside it, so the person describes what they see; **Duplicate** starts from an existing format.
- The editor: name, description, mechanism; a **slot editor** like the VO beat editor (add, reorder, name, word limit, guidance, example, required); variant tick boxes; always / never lists; references (add, remove, reorder); plate, text render and sizes under **Advanced** (collapsed).
- **Import CSV:** one format per row (name, description, variant text, rules), for a starter library. Imports as drafts without slots, to finish by hand or with the AI.
- Formats drafted by the AI carry the `ai-draft` tag until a person saves them, as hooks do.

---

## 3. Brand kits (Brands → brand page → **Design kit**)

**brand_kits** (one per brand)
- `colors jsonb`: `[{ "name": "Primary", "hex": "#..." }]`
- `fonts jsonb`: `[{ "role": "headline" | "body", "family": "...", "file": "<storage path>" | null }]`. Uploaded font files are used by overlay formats; otherwise the family name is passed to Kanvas.
- `logos`: files in the `brand-kits` bucket, each with a use (`light`, `dark`, `mark`)
- `style_notes text`, `rules jsonb` (`{ "always": [], "never": [] }`, applied on top of every format's)
- `dropbox_path text`: the brand's `_kit/` folder (§5), created with the brand's folders

The brand page gets a **Design kit** section (collapsed): swatches, fonts, logos, notes and rules, and **Open in Dropbox** for packshots. A brand with no kit can still get statics; Kanvas then takes its look from the references and the product stills, and the batch shows "no design kit".

---

## 4. Static copy (shoot → **Statics** tab)

Static copy is written in a shoot for its product, like VOs [§9], one per format the shoot uses.

**shoot_static_formats**: `shoot_id`, `static_format_id`, pk on both. Formats added to the shoot.

**static_copies** (like body_templates)
- `code text`: `A01`, `A02`, … per shoot, frozen when the shoot is planned
- `shoot_id`, `product_id` (required), `feature_id` (optional), `static_format_id`, `person_id` (who wrote it), `cast_channel_id` (as VOs: who it's for)
- `slots jsonb`: `[{ "slot": "headline", "text": "...", "alternates": [{ "text": "..." }] }]`. Slot keys must be the format's; every required slot has text. Alternates are other wordings, combined like a VO's [§12b Wording mixes].
- Slots work as in scripts [§5]: `{{brand}}`, `{{product}}`, channel slots (e.g. `{{dog}}`, filled per channel) and the shoot's custom slots (`{{offer}}`).
- `tags text[]`, `notes text`; `ai-draft` as VOs.
- Each slot's text is checked against its `max_words` (a warning, like a VO's length).
- Snapshotted when the shoot is planned, like every shoot item.

**Shoot setup** adds: `static_wording_variations int default 1` (≥ 0), as `wording_variations`; and `static_submission_rate numeric` (defaults from settings, as `submission_rate`).

The **Statics** tab lists the shoot's static formats, each with its copy (one card per `A##`, slots with their wordings, filled live while a draft) and the variants it will make. The calculator [§9] gets a **Statics** line: static recipes, per channel, and the batch size.

---

## 5. Stills on set

A shoot that has static formats with product or avatar variants asks for **stills** on the checklist [§10a].

**still_shots** (like broll_shots)
- `shoot_id`, `kind text check (kind in ('product','avatar'))`, `description text`, `sort_order`
- `feature_id` (optional, product stills): the product feature it shows
- `count int default 3`: photos wanted per channel (product) or per person (avatar)
- `status` (`planned`, `filmed`, `skipped`)

Suggested shots come from the variants: a product hero and a product in hand for product variants; a face-to-camera portrait, a person holding the product, and (on dog channels) the person with the dog for avatar variants. They can be edited, added and removed while the shoot is a draft.

**Checklist:** a **Stills** section after B-roll. Product stills: a row per channel, **Add photo** (pressed as often as wanted). Avatar stills: a row per person. Photos go through the same phone-first upload [§10a, §12]: saved on the phone, then uploaded straight to Dropbox, loose with autorename like b-roll. Checks: at least 1080 px on the short side; anything else saves without asking.

**Folders** (additions to [§10d]; the same list is in the contract):

```
UGC/
  _kanvas/plates/                          Kanvas's plates, per format (Kreate never reads them)
  [brand]/_kit/                            logo/, fonts/, packshots/
  [brand]/[product]/shoots/[S###]/
    raw/[channel]/stills/product/          product stills
    raw/[channel]/stills/avatar/[person]/  avatar stills
    statics.json
    batches/SB01.json, SB01.csv
    renders/SB01/[channel]/                static renders
```

The Dropbox tree builder [§12] creates these with the rest.

---

## 6. Static recipes

Built when the shoot goes Live, alongside the video recipes [§12b], into `statics.json` (contract). Logic in `shared/utils/staticRecipes.ts`, unit tested like `recipes.ts`.

**A valid static recipe:**
- **One format, one variant, one copy** (one wording of each slot), for **one channel**, filled for that channel.
- **Variants the format supports, whose ingredients are there:**
  - `text`: always;
  - `text_product`: always, using the channel's product stills and the brand's packshots when there are any (recorded as picks); with none, it's still made and Kanvas will draw the product (it's flagged, §7);
  - avatar variants: once per person on the channel who has an avatar still on the shoot or a filmed hook or CTA take; a person with neither gets none.
- **Wording mixes:** a copy whose slots have alternates makes up to `static_wording_variations` extra recipes, each a different combination (never all first wordings: that's the base). IDs add the wordings after the copy code, as VOs do (`A02.1.2`).
- **Asset picks:** for product variants, the stills are picked in a fixed order, varied across recipes, so different recipes use different photos where there are several. Deterministic.
- **IDs:** `S001_topdognix_SF03.text_product_A02.1.2_<hash of picks>`; avatar variants add the person (`S001_topdognix_joe_SF03.text_avatar_A02_<hash>`). Same inputs, same ID.
- Each recipe lists the format's sizes; sizes aren't separate recipes.

Treatments [§12b] don't apply to statics; variants do that job.

---

## 7. Static batches

Static recipes are batched **separately from video**, in the same loop [§12b Batches], so video and static scores never mix.

- `shoot_shortlists` gets `medium text check (medium in ('video','static')) default 'video'`. Static batches are coded `SB01`, `SB02`, …, and their size is `static_submission_rate` × valid static recipes.
- The **Batches** tab shows **Video** and **Statics** side by side, each with its own usage bar, next-batch button and history.
- **Status** as video: Batched → Rendering (Kanvas) → Submitted → Measured.
- **Review before submitting:** the batch reads `edited/_kanvas.json` and shows each ad with its sizes and flags.
  - `generated_product` **blocks**: the ad must be **Approved** or **Rejected** before the batch can move to Submitted. A rejected ad is left out of the submission and its recipe can go in a later batch.
  - `text_mismatch`, `rule_breach`, `composition`: warnings beside the ad; they never block (like Klip's `review.needed`).
  - Approvals: `static_render_reviews` (`shortlist_id`, `recipe_id`, `decision` `approved` | `rejected`, `by`, `at`).
- **Measuring** scores the elements a static batch used, in `batch_scores`, with new `element_kind`s: `static_format` (format code), `variant`, `static_copy` (copy code with wordings) and `person` (avatar variants). Winner / Mid / Loser by the same definitions.
- **Exploit / Explore / Drop / Spread** as video, with format and variant counting double (as treatments, hooks and formats do for video). Spread: no two recipes in a static batch share a format + copy pair; then the least-used variant, person and format first.
- **Undo** and **Reset** as video, per medium.

---

## 8. Kanvas: licence and billing

As Klip [§2 Billing, Klip licenses]:
- A Stripe product **UGC Kanvas**; `org_kanvas_access` alongside `org_klip_access` (bought, trial, seat, exempt).
- The licence payload adds `kanvasPurchased` and `kanvasAccess`; one device-code flow and one activation page serve both apps (the page names the app asking). **Sign out everywhere** covers Kanvas too, or gets its own button if Joe prefers.
- Seats [§3] cover Kanvas when the payer has it.

---

## 9. AI connector additions [§11]

Every tool below runs as the person, under the database's rules, through the same shared code as the app (`shared/utils/staticPlan.ts`). Results carry `link`s.

| Tool | Does |
|---|---|
| `get_static_formats` | the Library's static formats; with `id`, one format **with its reference images as image content**, so the AI can see them |
| `add_static_format` | a new format (every field in §2), tagged `ai-draft`; references as image URLs (fetched and stored by Kreate) |
| `update_static_format` | any field, including slots, rules and references; archive / restore |
| `add_static_copy` / `update_static_copy` | copy for a shoot's static format, every slot with alternates; `ai-draft` until saved |
| `get_brand_kit` / `update_brand_kit` | a brand's kit (colours, fonts by name, style notes, rules; files stay a person's upload) |
| `add_still_shots` / `update_still_shots` / `remove_still_shots` | a draft shoot's stills list |
| `get_batches`, `score_batch`, `set_element_dropped` | as today, with `medium` |

`get_shoot` and `update_shoot` cover the shoot's static formats and static settings. `get_workspace` lists the static formats and variants.

**Turning an ad into a format with the AI:** the person either adds a draft format with the ad attached and asks their AI to fill it in (`get_static_formats` shows it the image; `update_static_format` writes the rest), or gives their AI the ad and has it call `add_static_format` with an image URL. The AI should check the Library first and suggest a variant of an existing format rather than a near-duplicate.

---

## 10. Manifest additions (contract)

`manifest.json` → `plan.static`: the shoot's static formats (every field in §2, references as signed storage URLs), the product's brand kit (§3, files as storage URLs and Dropbox paths), the static copies (filled per channel, snapshotted), the still shots with their spots, and `static_wording_variations`. `plan_hash` covers it. `MANIFEST_SCHEMA_VERSION` goes up by one.

---

## 11. Build phases

1. **Library:** `static_formats`, the Statics tab, the editor, CSV import, references bucket.
2. **Brand kits** on the brand page.
3. **Shoot:** shoot static formats, static copy, still shots, checklist Stills section, Dropbox folders, calculator line.
4. **Recipes and batches:** `staticRecipes.ts`, `statics.json`, `SB##` batches, the Statics column in Batches, reading `_kanvas.json`, reviews, scoring.
5. **Connector:** the tools in §9.
6. **Kanvas licence and billing.**

Acceptance: a shoot with three static formats (one per variant family) plans, films stills, goes Live, builds static recipes with stable IDs, picks SB01 with no two recipes sharing a format + copy, and shows Kanvas's renders with a blocking approval for a generated product.
