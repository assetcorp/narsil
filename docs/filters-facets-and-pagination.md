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

Field conditions belong under `fields`, and the `and`, `or`, and `not` combinators nest whole filter expressions, so you can write any boolean shape. The engine rejects any other key with `SEARCH_INVALID_FILTER`, so a field name written at the top level, such as `{ category: { eq: 'books' } }`, raises an error instead of silently matching everything, and so does a misspelled operator. Filters narrow the candidates a search scores: a full-text query needs a `term` to produce hits, and in vector and hybrid modes the filters restrict which documents the vector search considers.

## Facets

Facets return value counts alongside the hits for building filter UIs. Each count covers every document the query matches rather than the documents the page returns, so the counts stay the same whatever `limit` you ask for. String and enum facets take a `limit` and a `sort` direction, and numeric facets take explicit `ranges`.

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

A sorted query computes no relevance scores, so each hit arrives without a `score`. Pass `includeScores: true` to restore them, and each hit then carries the score it would carry without the sort. A sorted query carrying `minScore` still applies the floor, and it reports the scores only where `includeScores` is true.

A sort names a `number`, a `boolean`, or an `enum` field with no preparation. A sort names a text field only where the schema declares it `string:sortable`, and a sort naming a plain `string` field raises `SEARCH_INVALID_FIELD`. Every other field type, including every array field, counts as missing, so a sort naming one leaves every document equal.

The engine compares string values by their Unicode case fold, so `apple` orders between `Apple` and `Banana`. Two values with an equal fold compare by their raw code points. The engine compares only the first 512 code points of a value. The engine reads no locale, so a sorted page is the same on every machine. A sort names at most eight fields, because the paging cursor carries one value for each of them, and each field name holds at most 255 characters.

A missing value orders after every present value, under either direction. Present values of different types rank numbers first, then strings, then booleans.

The first sorted query on a field builds a column of that field's values, and every page after it reads the documents that follow its cursor anchor rather than walking the index. Measured on 120,000 documents on an Apple M-series laptop, the build cost 159ms for short text and 398ms for values above the 512 code point window, and each page after it cost 0.1ms. Writes keep the column current, which cost 12% of insert throughput for one text field and one number field over 119,000 documents.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  sort: { price: 'asc', title: 'asc' },
})
```

A sort also takes a list, which is the form to use where the order of the fields matters and an object cannot carry it, because JavaScript moves an all-digit key such as `2024` to the front of an object.

```ts
const results = await narsil.query('sales', {
  term: 'keyboard',
  sort: [
    { field: 'region', direction: 'asc' },
    { field: '2024', direction: 'desc' },
  ],
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

Shallow pagination uses `limit` and `offset`, while deep pagination uses `searchAfter` cursors, whose cost per page stays flat at any depth. A cursor anchors on the last result of the page: the score for a relevance-ranked query, or the sort values for a sorted one. Every page's result carries a `cursor` string; pass it back as `searchAfter` to fetch the next page.

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

A cursor is valid only for the same query that produced it. The engine binds each cursor to the query's term, fields, filters, and match options, so a cursor sent back under a changed query fails with `SEARCH_INVALID_CURSOR`, as a malformed cursor does.

`offset` and `limit` together reach the first 10,000 results, which is the result window. A request past it throws `SEARCH_RESULT_WINDOW_EXCEEDED`, and a cursor pages beyond it because each page returns the `limit` results that follow its anchor. The window bounds paging depth rather than what the engine considers: a sort, a group, a `minScore`, and a `termMatch` other than `any` each read every matching document, and `count` reports the number of matches exactly.

## Pinning

`pinned` places specific documents at fixed positions in the ranked results, which serves sponsored or editorial placements. Positions are zero-based.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  pinned: [{ docId: 'kb-editorial-pick', position: 0 }],
})
```
