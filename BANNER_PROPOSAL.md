# Cubist Souls — collection image / banner proposal (F0.5)

> Status: **PROPOSAL ONLY — do NOT change `api/collection.js` until Adrian picks one.**
> Today `api/collection.js` returns `image: https://cubistsouls.vercel.app/soul.jpg`,
> a generic single-soul placeholder. This is the OpenSea `contractURI().image`
> (collection avatar / social card the diamond's renderer points to).

## Constraints
- Must be a stable public URL (served from this Vercel project, same origin as
  `/api/img` and `/soul.jpg`). OpenSea caches it hard — pick once, change rarely.
- Square works best as the collection avatar; a wide crop can double as banner.
- All source art already reachable bit-for-bit via `/api/img?id=<tokenId>`.

## Option A — Grid of real freed souls (recommended)
A 3×3 (or 4×2) mosaic built from the souls that have actually been freed on-chain
(today `totalSupply()` = 5, growing with every burn). Honest provenance: the
collection image literally is the collection.
- Build: a small `api/collection-image` endpoint (sharp) that reads the freed
  tokenIds (Transfer from=0 logs, same pattern as the page's `candidateIds`) and
  composites their `/api/img` PNGs into a grid, cached immutable + periodic bust.
- Pro: self-updating, truthful, striking. Con: needs a new endpoint (sharp) and
  looks sparse until there are ≥6-9 souls — until then pad with hero picks
  (#136, #1064 + the honorary 1/1s #90/#163/#294/#600).

## Option B — The layer-recovery proof poster
Use `cubist-souls-assets/proof/layers_poster.png` (the trait-differencing proof:
a soul exploded into its recovered layers). Tells the "art recovered from ashes"
story in one image — the whole thesis of the project.
- Build: copy/host the poster as a static asset here, point `image` at it.
- Pro: zero moving parts, conceptually on-brand, no endpoint. Con: more
  "explainer" than "avatar"; needs a clean square crop; asset lives in another
  repo (owned by another worker — coordinate, don't touch it directly).

## Option C — Single hero soul, upgraded (lowest effort)
Replace the generic `soul.jpg` with one strong, high-res freed soul (e.g. #136,
the pixel-perfect PoC, or #1064) at full 768². Keeps today's single-image model.
- Build: drop `soul-hero.jpg` in the repo, point `image` at it. Con: least
  distinctive; doesn't convey the "10,000 / burn to free" concept.

## Recommendation
Ship **C now** (one-line, instant upgrade over the placeholder) and build **A**
as the durable answer once there are enough freed souls to fill a grid (≈9).
B is the best *social/announce* image (pair with the F4.4 launch post), less
ideal as the permanent avatar.
