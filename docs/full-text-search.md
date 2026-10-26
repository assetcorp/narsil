# Full-text search

This guide explains term matching, typo tolerance, prefix completion, matching inside words, match thresholds, highlighting, scoring modes, and suggestions. The [Filters, facets, and pagination](filters-facets-and-pagination.md) guide explains how to narrow and page the result set that a query returns.

Every search goes through `query(indexName, params)`. Set its `mode` parameter to `'fulltext'`, which is the default, or to `'vector'` or `'hybrid'`.

## Basic queries

The engine scores a full-text search with BM25. With `fields`, the engine searches the named fields alone. With `boost`, it multiplies the score from each named field by that field's weight. A boost works only on a text field that the schema declares, so the engine throws `SEARCH_INVALID_FIELD` for a boost on any other field. A weight has to be a finite number, so the engine throws `CONFIG_INVALID` for any other value.

```ts
const results = await narsil.query('products', {
  term: 'wireless keyboard',
  fields: ['title', 'description'],
  boost: { title: 2.0 },
  limit: 10,
  offset: 0,
})
```

The default `limit` is 10. Each hit has the shape `{ id, score, document, highlights?, scoreComponents? }`. Pass `includeScoreComponents: true` to receive per-term frequencies, field lengths, and IDF values for debugging a ranking. For a sorted query, the engine computes a `score` for each hit only when you set `includeScores: true`.

## Choosing what comes back

By default, each hit contains the whole stored document. Set `document` to return part of it or none of it. Pass `false` where the ids and scores are all you need; every hit's `document` is then an empty object. Pass `include` to keep the named fields alone, or `exclude` to drop the named fields and keep the rest. Use dots to name a nested field, such as `author.name`. The engine applies only the names that match a field.

```ts
const results = await narsil.query('products', {
  term: 'wireless keyboard',
  document: { exclude: ['embedding'] },
})
```

Exclude a vector field on a similarity search. The engine copies out of the store only the fields that the projection keeps. It also reads a vector back out of the index only for a field that the projection keeps. When you keep a 384-dimension vector, each hit in the response grows by about 8 KB.

## Fuzzy matching

With `tolerance`, the engine matches an indexed term that is within that many edits of a query term, counting each Unicode code point as one character. Set it to a whole number from 0 to 10. At the default of 0, the engine matches exact terms alone. With `prefixLength`, the engine checks only the indexed terms that share that many leading characters with the query term, or the terms that start with the whole query term when the query term is shorter. Set it to a whole number from 0 to 1,024; the default is 2. With a larger value, the engine checks fewer terms, so a fuzzy lookup finishes sooner and matches fewer terms. The engine throws `CONFIG_INVALID` for a value outside either range. With `exact: true`, the engine turns fuzzy expansion off for the whole query.

```ts
const results = await narsil.query('products', {
  term: 'keybaord',
  tolerance: 2,
  prefixLength: 3,
})
```

## Search as you type

With `prefix: true`, the engine treats the last word of the query as unfinished, so `secur` matches documents that contain `security`. The engine matches the last word by its stem or by completing it, while `tolerance` applies only to the earlier words, which have to match in full. The engine scores every completion against one shared document frequency. It also ranks completions below full-word matches, so a document that contains the exact typed word comes first. The option is off by default; turn it on for queries that an app sends on every keystroke.

The engine matches completions against the original spellings that the index records, so it completes `securi` to `security` although the term dictionary stores the stem `secur`. Create the index with `surfaceForms: false` to match completions against the stemmed tokens. That setting speeds up inserts, because the engine skips recording the original spellings. However, a typed word that goes past the end of a stem, such as `securi`, then matches nothing.

```ts
const results = await narsil.query('products', {
  term: 'mechanical keyb',
  prefix: true,
})
```

## Matching inside words

With `partialWords: true`, the engine also matches each query word of three or more characters inside the longer words of every field whose type includes `partial`, so a search for `proof` matches a jacket with `waterproof` in its title. Declare such a field as `string:partial` or `string[]:partial`. The engine looks for the query word, before stemming, inside each word exactly as that word appears in a document. It then matches every document that contains a word with the same stem as a word that it found there. If one title contains `waterproofs`, for example, a search for `proofs` also matches the titles that contain `waterproof`, because the two words share the stem `waterproof`.

The engine adds at most 50 such words to a query, which it divides as evenly as it can among the query words. Within the share of each query word, it adds first the words that the most documents contain. It scores a match inside a longer word in proportion to the part of that word that the query word makes up. Since `proof` makes up 5 of the 10 characters in `waterproof`, the engine scores that match at half of what it gives `proof` as a whole word at the same frequency in a field of the same length. The engine applies no `tolerance` to these matches. It ignores `partialWords` under `exact: true`, and also in a search whose `fields` list contains no `partial` field.

With `highlight`, the engine tags each whole word that contains a query word of three or more characters in a searched `partial` field, so it tags `waterproof` in a search for `proof`. It leaves every stop word untagged, because it leaves stop words out of the index. It also leaves a word untagged where the engine matched the document only through a shared stem, such as `waterproof` in a search for `proofs`.

```ts
await narsil.createIndex('products', {
  schema: { title: 'string:partial', description: 'string' },
})

const results = await narsil.query('products', {
  term: 'proof',
  partialWords: true,
})
```

The engine matches inside the original spellings of words, which it records only while the index's `surfaceForms` setting is on, so it throws `CONFIG_INVALID` for a `partial` field in an index whose `surfaceForms` setting is off. Each segment that the engine saves for an index with a `partial` field holds the written spellings of more than three code points in those fields, the number of times that each spelling occurs, and a lookup from every run of three code points to the spellings that contain it. When the engine loads or restores the index, it reads that list from each segment, so it analyses no document again. Where a segment holds no such list, or holds one for other `partial` fields than the index declares, the engine reads that segment's documents to build the list, either while it loads the index or during the first query with `partialWords: true`. In the part of each partition that is still taking writes, the engine counts the spellings as documents arrive, while it builds the lookup by runs only during the first query with `partialWords: true`. For an index without a `partial` field, the engine stores and builds no such list.

A Node process loads the partial-word search code by itself. A browser bundle contains that code only when the app imports `partialWordSearch` and registers it. Register `partialWordSearch` before the app creates or loads an index with a `partial` field:

```ts
import { registerPartialWordSearch } from '@delali/narsil'
import { partialWordSearch } from '@delali/narsil/partial-words'

registerPartialWordSearch(partialWordSearch)
```

Without that registration, the engine throws `CONFIG_INVALID` for an index with a `partial` field, and the error message contains the import line.

## Score and coverage thresholds

With `minScore`, the engine drops every hit whose score is below that floor. BM25 scores have no fixed upper bound, so under a floor that works for one index and query, the engine can drop every hit of another. Choose the floor from scores that you have seen on your own corpus. With `termMatch`, you set how many query terms a document has to match. Under the default, `'any'`, a document has to match one term, under `'all'` every term, and under a number at least that many terms. The engine counts a query term as matched under the same `tolerance` and `prefixLength` that the search uses.

```ts
const results = await narsil.query('products', {
  term: 'mechanical gaming keyboard',
  termMatch: 2,
  minScore: 1.5,
})
```

## Highlighting

With `highlight`, the engine returns snippets in which it tags each word that it matched. It tags a word whose stem equals a query stem, and a word within `tolerance` of a query stem. Under `prefix: true`, it tags a word for the last query term only when that word completes the term or shares its stem. Under `partialWords: true`, it also tags a word in a `partial` field that contains a query word; see [Matching inside words](#matching-inside-words) for the rules. The engine analyses the text of each returned field again, so it tags the same words whatever the index's `trackPositions` setting is.

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

When an index spans partitions or instances, each one holds its own term statistics, so the scores are approximate where partition sizes or term distributions differ. Choose one of three scoring modes, depending on how much of that skew you can accept:

- Under `'local'`, which is the default and the fastest mode, the engine scores each partition with its own statistics.
- Under `'dfs'`, the engine first collects the global term statistics in one round trip, then scores with unified IDF values in a second.
- Under `'broadcast'`, the engine scores from the global statistics that the instances exchange through the invalidation adapter.

Set a per-index default with `defaultScoring` in the index config, or set `scoring` per query:

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  scoring: 'dfs',
})
```

## Preflight

The engine answers `preflight(indexName, params)` with the match count alone, so it skips building, ranking, and paging hits. Use it to size a result set before you send an expensive query.

```ts
const { count, elapsed } = await narsil.preflight('products', { term: 'keyboard' })
```

## Suggestions

`suggest(indexName, params)` returns autocomplete candidates. The engine splits the input into words, then treats the last word as the prefix. It ranks the completions by the number of documents that each one matches. The engine suggests each word as your documents spell it, so for a catalogue that contains 'mechanical' it suggests `mechanical`, while the index stores the stem `mechan`. To do this, the engine records the original spelling of every word that the stemmer changes. Create the index with `surfaceForms: false` to have the engine suggest the stored stems.

```ts
await narsil.createIndex('products', {
  schema: { title: 'string', description: 'string' },
})

const suggestions = await narsil.suggest('products', { prefix: 'mech', limit: 5 })
// suggestions.terms => [{ term: 'mechanical', documentFrequency: 12 }, ...]
```
