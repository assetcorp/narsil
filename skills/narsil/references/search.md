# Keyword search, filters, facets, and pagination

## A catalogue search

```ts
await narsil.createIndex('products', {
  schema: {
    title: 'string',
    description: 'string',
    brand: 'enum',
    category: 'enum',
    price: 'number',
    inStock: 'boolean',
    tags: 'string[]',
    name: 'string:sortable',
  },
})

const results = await narsil.query('products', {
  term: 'wireles hedphones',
  tolerance: 1,
  filters: { fields: { inStock: { eq: true }, price: { lte: 200 } } },
  facets: {
    brand: { limit: 10 },
    inStock: {},
    price: { ranges: [{ from: 0, to: 50 }, { from: 50, to: 150 }, { from: 150, to: 1000 }] },
  },
  boost: { title: 2 },
  highlight: { fields: ['title'] },
  limit: 20,
})
```

- A query scores with BM25 and admits a document that holds any one term. Set `termMatch: 'all'`, or a number of terms, to demand more.
- `tolerance` defaults to 0, so a misspelt word matches nothing until you set it. Set 1 or 2. The engine applies it only to indexed terms that share the first `prefixLength` characters with the query term, 2 by default, so a typo in the first two letters still misses.
- For search as you type, set `prefix: true`, which completes the last word. `narsil.suggest(index, { prefix, limit })` returns whole terms for a dropdown.
- The engine stems text, so `bicycles` matches `bicycle`. `exact: true` turns off tolerance and prefix completion.

## Filters and facet counts

- `filters.fields` takes `eq` and `ne` on any scalar field, `gt`, `gte`, `lt`, `lte`, and `between` on numbers, `in`, `nin`, `startsWith`, and `endsWith` on strings, `containsAll`, `matchesAny`, and `size` on arrays, and `exists`, `notExists`, `isEmpty`, and `isNotEmpty` on any field. Combine expressions with `and`, `or`, and `not`.
- The engine throws `SEARCH_INVALID_FILTER` for an operator that the field's type lacks, such as `startsWith` on a number.
- The engine counts `facets` over every document that matches the term and the filters, whatever `limit` the query sets, so `limit: 0` returns the counts alone. Each facet result holds `values`, keyed by value as a string, and an `errorBound`, where 0 means that every count is exact.
- A number field takes `ranges`. A boolean facet keys its counts under `'true'` and `'false'`. The engine counts a plain `string` field by whole values, so declare a field that a sidebar counts as `enum`.
- A query with no `term` and no `vector` matches nothing. To list documents by filter alone, call `narsil.listDocuments(index, { filters, sort, limit, cursor })`, which takes the same `filters` and `sort` and returns no facets.

## Sorting, grouping, and pages

- `sort: { price: 'asc' }` orders by field value in place of relevance, and a list such as `[{ field: 'price', direction: 'asc' }, { field: 'name', direction: 'asc' }]` keeps the order of several fields. A sorted hit carries no `score` unless the query sets `includeScores: true`.
- `group: { fields: ['brand'], maxPerGroup: 3 }` returns `results.groups`, each with its field values and best hits.
- For the next page, repeat the same query with `searchAfter: results.cursor`, and stop once `cursor` is absent. `offset` works too, but a deep offset costs more, and the HTTP server refuses an `offset` past 10,000.
- `results.count` holds the total number of matches, and `narsil.preflight(index, params)` returns that count without building any hits.
- `pinned: [{ docId, position }]` places chosen documents at fixed positions.

## Highlighting

With `highlight: { fields }`, each hit carries `highlights[field]`, which holds a `snippet` with each match wrapped in `<mark>` tags and the `positions` of each match as character offsets into the stored field. The snippet holds about 200 characters of the field around its densest run of matches, and `maxSnippetLength` sets that length. The engine leaves the field's own text unescaped, so escape the text between the tags, or build the markup yourself from `positions`, before you insert a snippet into HTML.

## Geosearch

Declare a `geopoint` field and store `{ lat, lon }` in degrees. Filter it inside a query that carries a `term`, or through `listDocuments`:

```ts
filters: { fields: { location: { radius: { lat: 5.5502, lon: -0.2174, distance: 50, unit: 'km' } } } }
filters: { fields: { location: { polygon: { points: [{ lat: 5.4, lon: -0.4 }, { lat: 5.4, lon: 0.1 }, { lat: 5.8, lon: 0.1 }, { lat: 5.8, lon: -0.4 }] } } } }
```

`unit` takes `'km'`, `'mi'`, or `'m'`, and `inside: false` flips either test. List a polygon's corners counter-clockwise. A sort or a facet cannot name a `geopoint` field.
