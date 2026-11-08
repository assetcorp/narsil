# Natural Earth populated places

The places in this directory come from the Natural Earth 1:50m populated places layer, which Natural Earth publishes as vector map data.

- **Publisher**: Natural Earth, <https://www.naturalearthdata.com>
- **Source repository**: <https://github.com/nvkelso/natural-earth-vector>
- **Source file**: `geojson/ne_50m_populated_places_simple.geojson` at commit `ca96624a56bd078437bca8184e78163e5039ad19`
- **Source file SHA-256**: 8e70756b39fae9bcdc1e332bfc510c024c5edd3a13203ffd20092ee37b61d978

## Licence

Natural Earth places all of its data in the public domain, as the `LICENSE.md` file in the source repository and the terms of use at <https://www.naturalearthdata.com/about/terms-of-use/> state. Anyone may copy, change, and redistribute the data without asking permission.

## Conversion notes

`scripts/convert-natural-earth-places.py` downloads the source file at the commit above, checks its SHA-256, and writes `places.json` sorted by the Natural Earth ID. Each place keeps its name, its country (`adm0name`), its first-level region (`adm1name`) where Natural Earth records one, its feature class as `kind`, its largest population estimate (`pop_max`), and every positive estimate of `pop_min`, `pop_other`, and `pop_max` as `populations`. The script rounds each coordinate to 5 decimal places, turns the `adm0cap`, `worldcity`, and `megacity` flags into `tags`, and joins the name, region, country, and tags into a one-line `summary`.

`places-vectors-384.bin` holds one 384-number embedding of each place's `summary`, in the order of `places.json`. `packages/ts/examples/browser/scripts/embed-places.ts` writes it with `@delali/narsil-embeddings-transformers` and the `Xenova/all-MiniLM-L6-v2` model at `q8` precision. The file opens with two little-endian 32-bit unsigned integers, the number of places and the number of dimensions, followed by each vector as little-endian 32-bit floats.
