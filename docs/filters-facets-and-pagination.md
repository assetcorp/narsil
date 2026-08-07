# Filters, facets, and pagination

A query narrows and orders its results through the options this guide covers: filters, facet counts, sorting, grouping, cursors, and pinned hits. [Full-text search](full-text-search.md) covers the matching itself.

## Filters

Filter on any indexed field with comparison operators (`eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `between`), string operators (`in`, `nin`, `startsWith`, `endsWith`), array operators (`containsAll`, `matchesAny`, `size`), and presence checks (`exists`, `notExists`, `isEmpty`, `isNotEmpty`). Combine filter expressions with `and`, `or`, and `not`.

```ts
const results = await narsil.query('products', {
  term: 'wireless',
  filters: {
    or: [
      { fields: { category: { eq: 'electronics' } } },
      { fields: { category: { eq: 'accessories' } } },
    ],
    fields: {
      price: { between: [10, 100] },
      tags: { containsAll: ['bluetooth'] },
    },
  },
})
```

Field conditions live under `fields`, and the `and`, `or`, and `not` combinators nest whole filter expressions, so any boolean shape is expressible. Filters narrow the candidates a search scores: a full-text query needs a `term` to produce hits, and in vector and hybrid modes the filters restrict which documents the vector search considers.

## Facets

Facets return value counts alongside the hits for building filter UIs. String and enum facets take a `limit` and a `sort` direction, and numeric facets take explicit `ranges`.

```ts
const results = await narsil.query('products', {
  term: 'laptop',
  facets: {
    category: { limit: 10, sort: 'desc' },
    price: { ranges: [{ from: 0, to: 500 }, { from: 500, to: 1000 }, { from: 1000, to: 5000 }] },
  },
})

// results.facets => { category: { values: { electronics: 42, computers: 28 }, count: 70 }, ... }
```

## Sort

`sort` orders hits by field values instead of score. Multiple entries apply in order, so the second field breaks ties in the first. When every sort field ties, the engine orders the tied hits by document id.

The engine compares string values by their Unicode case fold, so `apple` orders between `Apple` and `Banana`. Two values with an equal fold compare by their raw code points. The engine reads no locale, so a sorted page is the same on every machine. A sort names at most eight fields, because the paging cursor carries one value for each of them.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  sort: { price: 'asc', title: 'asc' },
})
```

## Grouping

`group` collapses hits that share field values. `maxPerGroup` caps how many hits each group keeps, and an optional reducer folds every grouped document into an accumulated value.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  group: {
    fields: ['category'],
    maxPerGroup: 3,
  },
})

// results.groups => [{ values: { category: 'electronics' }, hits: [...] }, ...]

const withTotals = await narsil.query('products', {
  term: 'keyboard',
  group: {
    fields: ['category'],
    reduce: {
      initialValue: () => 0,
      reducer: (total, doc) => (total as number) + ((doc.price as number) ?? 0),
    },
  },
})
```

## Pagination

Shallow pagination uses `limit` and `offset`. Deep pagination uses `searchAfter` cursors. The cost of a cursor page stays flat at any depth. A cursor anchors on the last result of the page: the score for a relevance-ranked query, or the sort values for a sorted one. Every page's result carries a `cursor` string; pass it back as `searchAfter` to fetch the next page.

```ts
const firstPage = await narsil.query('products', { term: 'keyboard', limit: 20 })

if (firstPage.cursor) {
  const secondPage = await narsil.query('products', {
    term: 'keyboard',
    limit: 20,
    searchAfter: firstPage.cursor,
  })
}
```

A cursor is only valid for the same query parameters it came from. A malformed cursor fails with `SEARCH_INVALID_CURSOR`.

## Pinning

`pinned` places specific documents at fixed positions in the ranked results, which serves sponsored or editorial placements. Positions are zero-based.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  pinned: [{ docId: 'kb-editorial-pick', position: 0 }],
})
```
