# Full-text search

This guide covers term matching, typo tolerance, prefix completion, match thresholds, highlighting, scoring modes, and suggestions. [Filters, facets, and pagination](filters-facets-and-pagination.md) covers narrowing and paging the result set a query returns.

`query(indexName, params)` runs every search. The `mode` parameter selects `'fulltext'` (the default), `'vector'`, or `'hybrid'`.

## Basic queries

Full-text search scores with BM25. `fields` restricts the search to specific fields, and `boost` multiplies per-field scores.

```ts
const results = await narsil.query('products', {
  term: 'wireless keyboard',
  fields: ['title', 'description'],
  boost: { title: 2.0 },
  limit: 10,
  offset: 0,
})
```

`limit` defaults to 10. Each hit has the shape `{ id, score, document, highlights?, scoreComponents? }`. Pass `includeScoreComponents: true` to receive per-term frequencies, field lengths, and IDF values for debugging a ranking. A sorted query computes no scores, so its hits carry no `score` until the query sets `includeScores: true`.

## Choosing what comes back

Each hit includes the whole stored document by default, and `document` narrows that. Pass `false` when the ids and scores are all you need, and every hit's `document` is then an empty object. Pass `include` to keep named fields alone, or `exclude` to drop named fields and keep the rest. Use dots to name a nested field, such as `author.name`. The engine ignores a name that matches no field.

```ts
const results = await narsil.query('products', {
  term: 'wireless keyboard',
  document: { exclude: ['embedding'] },
})
```

Exclude a vector field on a similarity search. The engine otherwise reads every hit's vector back out of the index and writes it into the response, which costs about 8 KB per hit for a 384-dimension field.

## Fuzzy matching

`tolerance` sets the maximum Levenshtein edit distance between a query term and an indexed term. It defaults to 0, which requires exact matches. `prefixLength` limits fuzzy candidates to terms sharing that many leading characters with the query term; it defaults to 2, and raising it makes fuzzy lookups faster and stricter. `exact: true` turns fuzzy expansion off for the whole query.

```ts
const results = await narsil.query('products', {
  term: 'keybaord',
  tolerance: 2,
  prefixLength: 3,
})
```

## Search as you type

`prefix: true` treats the last word of the query as an unfinished word, so `secur` matches documents containing `security`. Earlier words must match fully, and `tolerance` keeps applying to them while the unfinished word is completed instead of typo-corrected. Completions score against a shared document frequency and rank below full-word matches, so a document containing the exact typed word comes first. The option is off by default; turn it on for queries fired on every keystroke.

Completions match against the term dictionary, which stores stemmed tokens, so a typed word that runs past the end of a stem stops matching: `security` is indexed as `secur`, and the query `securi` finds nothing. Create the index with `surfaceForms: true` to match completions against the original spellings instead; the same setting gives [suggestions](#suggestions) their display words.

```ts
const results = await narsil.query('products', {
  term: 'mechanical keyb',
  prefix: true,
})
```

## Score and coverage thresholds

`minScore` drops hits scoring below a floor. `termMatch` sets how many query terms a document must match: `'any'` (the default) accepts one term, `'all'` requires every term, and a number requires at least that many terms.

```ts
const results = await narsil.query('products', {
  term: 'mechanical gaming keyboard',
  termMatch: 2,
  minScore: 1.5,
})
```

## Highlighting

`highlight` returns snippets with tags marking where query terms appear. Highlighting needs `trackPositions` left at its default of `true`.

```ts
const results = await narsil.query('products', {
  term: 'mechanical',
  highlight: {
    fields: ['title', 'description'],
    preTag: '<mark>',
    postTag: '</mark>',
    maxSnippetLength: 160,
  },
})

// hit.highlights?.title.snippet => '<mark>Mechanical</mark> Keyboard'
```

## Scoring modes

Three scoring modes handle the statistics-skew problem that appears when an index spans partitions or instances:

- `'local'` scores each partition with its own statistics. It is the fastest mode and the default.
- `'dfs'` runs a two-phase query that first collects global term statistics, then scores with unified IDF values.
- `'broadcast'` has instances share statistics through the invalidation adapter, so scoring uses pre-computed global values.

Set a per-index default with `defaultScoring` in the index config, or set `scoring` per query:

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  scoring: 'dfs',
})
```

## Preflight

`preflight(indexName, params)` returns the match count for a query without materializing, ranking, or paginating hits. Use it to size a result set before running an expensive query.

```ts
const { count, elapsed } = await narsil.preflight('products', { term: 'keyboard' })
```

## Suggestions

`suggest(indexName, params)` returns autocomplete candidates. It tokenizes the input, takes the last word as the prefix, and ranks completions by the number of documents they match. By default the candidates are the stemmed tokens the index stores, so a catalogue containing "mechanical" suggests the stem `mechan`. Create the index with `surfaceForms: true` to suggest the words as they appear in your documents; the engine then records the original spelling of every word the stemmer changed and suggests `mechanical` instead.

```ts
await narsil.createIndex('products', {
  schema: { title: 'string', description: 'string' },
  surfaceForms: true,
})

const suggestions = await narsil.suggest('products', { prefix: 'mech', limit: 5 })
// suggestions.terms => [{ term: 'mechanical', documentFrequency: 12 }, ...]
```
