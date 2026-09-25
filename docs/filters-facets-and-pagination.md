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

The engine returns value counts alongside the hits when you ask for facets, which is what a filter panel needs. It counts every document that the query matches, so the counts stay the same whatever page `limit` you ask for. A string or enum facet accepts a `limit` and a `sort` direction, while a numeric facet accepts explicit `ranges`.

```ts
const results = await narsil.query('products', {
  term: 'laptop',
  facets: {
    category: { limit: 10, sort: 'desc' },
    price: { ranges: [{ from: 0, to: 500 }, { from: 500, to: 1000 }, { from: 1000, to: 5000 }] },
  },
})

// results.facets => { category: { values: { electronics: 42, computers: 28 }, count: 2, errorBound: 0 }, ... }
```

Each field's `count` is the number of values that the engine returns for it, which the facet's `limit` caps. Its `errorBound` is the most that any of those counts can fall short of its true count. A value that the engine drops to stay within `limit` matches at most that many documents as well. Where the engine counts a field on one thread, it counts every value exactly, including across the partitions of a large index, so the bound there is the largest count that it drops. Where it splits the count across worker copies or cluster nodes, each of them returns only its own top values. A value that is common overall but rare on one of them can then lose that one's share, which the bound grows to cover.

## Sort

`sort` orders hits by field values in place of their scores. The engine compares the entries in order, so the second field breaks ties in the first. When every sort field ties, the engine orders the tied hits by document id.

A sorted query computes no relevance scores, so each hit arrives without a `score`. Pass `includeScores: true` to restore them, and each hit then carries the score it would carry without the sort. A sorted query carrying `minScore` still applies the floor, and it reports the scores only where `includeScores` is true.

A sort names a `number`, a `boolean`, or an `enum` field with no preparation. A sort names a text field only where the schema declares it `string:sortable`, and a sort naming a plain `string` field raises `SEARCH_INVALID_FIELD`. A sort naming a `geopoint` or a vector field raises `SEARCH_INVALID_FIELD` as well, because neither type has an order. An array field counts as missing, so a sort naming one leaves every document equal.

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

The engine collapses the hits that share field values into one group for each set of values when you set `group`. It returns up to `maxPerGroup` hits from each group, and one hit where you leave that out, while it returns up to `limit` groups, best first. An optional reducer folds every hit of each group into one value, including the hits beyond `maxPerGroup`, so a reducer that sums a field adds up the whole group. In cluster mode the coordinator fetches up to 10,000 hits of each group to fold.

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

A cursor is valid only for the same query that produced it. The engine binds each cursor to the query's term, fields, filters, match options, and scoring mode, so a cursor sent back under a changed query fails with `SEARCH_INVALID_CURSOR`, as a malformed cursor does.

`offset` and `limit` together reach the first 10,000 results, which is the result window. A request past it throws `SEARCH_RESULT_WINDOW_EXCEEDED`, and a cursor on a keyword search pages beyond it because each page returns the `limit` results that follow its anchor. The window bounds paging depth, and it leaves untouched what the engine considers, since a sort, a group, a `minScore`, and a `termMatch` other than `any` each read every matching document.

The engine pages a vector search differently. Because it reads a fraction of a field that has grown a graph, it can reach the rank in the cursor only by fetching every result above that rank. It therefore fetches to that depth plus one more page each time, and it raises `SEARCH_RESULT_WINDOW_EXCEEDED` where that reach passes the result window. Set a filter or a `similarity` floor on such a search so that fewer vectors qualify, and read [Vector search](vector-search.md#result-totals-and-paging) for the whole rule.

## What `count` reports

`count` holds the number of documents that the query matches, before `limit` and `offset` apply. Read `countExact` to know whether that number is the total or a floor under it.

For a keyword search the engine counts every match, so `countExact` is true. For a vector search it counts every vector that the query's filter and its `similarity` floor admit, which is the whole field where the query sets neither of them. That count stays exact while the engine compares the query with every vector that it admits.

Where the field has grown a graph and the query sets a `similarity` floor, the engine reads a fraction of the field. `count` then holds the number of vectors that the engine fetches, and `countExact` is false. A hybrid search fuses two rankings, so its `countExact` is true only where both of those rankings return every document that they match.

```ts
const result = await narsil.query('products', {
  vector: { field: 'embedding', value: myQueryVector, similarity: 0.8 },
  limit: 20,
})

const total = result.countExact ? `${result.count}` : `${result.count} or more`
```

## Pinning

The engine places each `pinned` document at a fixed position in the ranked results, which is how you show a sponsored or editorial placement. The engine counts positions from zero at the top of the whole result set, so a page reached with `searchAfter` holds no pinned placements. It anchors a cursor on the last result that is not a placement, so a page that holds only placements comes back with no cursor.

The engine also counts each pinned document that the query never matched in `count`, since that document appears among the hits. Where the engine fetches only a fraction of the matches, as it does for a vector search over a field that has grown a graph, a pinned document from outside those hits may or may not be a match. The engine then leaves that document out of `count` and reports `countExact` as false.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  pinned: [{ docId: 'kb-editorial-pick', position: 0 }],
})
```
