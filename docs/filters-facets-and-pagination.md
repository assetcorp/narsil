# Filters, facets, and pagination

The engine narrows and orders the results of a query by its filters, facet counts, sort, grouping, cursor, and pinned hits. [Full-text search](full-text-search.md) holds the rules for matching the terms themselves.

## Filters

Filter on any indexed field with comparison operators (`eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `between`), string operators (`in`, `nin`, `startsWith`, `endsWith`), array operators (`containsAll`, `matchesAny`, `size`), and presence checks (`exists`, `notExists`, `isEmpty`, `isNotEmpty`). Combine filter expressions with `and`, `or`, and `not`. On a `string[]` field, the engine compares each element of the list with `eq`, `ne`, `in`, `nin`, `startsWith`, and `endsWith`, so `eq: 'vegan'` matches a document whose list includes `'vegan'`, while `ne` and `nin` match a document whose list includes none of the values.

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

Put each field condition under `fields`, and nest whole filter expressions inside `and`, `or`, and `not`, so that you can write any boolean shape. The engine throws `SEARCH_INVALID_FILTER` for any other key, so it raises that error for a field name written at the top level, such as `{ category: { eq: 'books' } }`, and for a misspelled operator. It raises the same error for an operand of the wrong shape, such as a `between` with one bound or a `radius` with a negative `distance`, for an `and` or `or` clause that is not a list, for an expression nested more than 30 levels deep, and for an operator on a field of another type, such as `startsWith` on a `number` field or `eq: '700'` on one. The engine compares a filter on a field outside the schema with the value that each document stores under that name, except on a strict index, where it throws `SEARCH_INVALID_FIELD` for a filter, sort, facet, or group on such a field, because the engine rejects every document with that field. The engine scores only the documents that pass the filters. It returns hits for a full-text query only when you set a `term`, while in vector and hybrid modes it compares the query vector with only the documents that pass the filters.

## Facets

When you set `facets`, the engine returns the number of matching documents for each value of each field that you name, which you can show beside each option of a filter panel. It counts every document that the query matches, so the counts are the same whatever page `limit` the query sets. Set a `limit` and a `sort` direction on a string or enum facet, and explicit `ranges` on a numeric facet. For a field outside the schema, the engine counts the values that the documents store, and it returns an empty facet where no matching document stores one. It throws `SEARCH_INVALID_FIELD` for a facet on a `geopoint` or a vector field.

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

Each field's `count` is the number of values that the engine returns for that field, which is at most the facet's `limit`. Its `errorBound` is the most by which any count in `values` can be lower than the true count. A value that the engine leaves out of `values` because of `limit` matches at most that many documents too. Where the engine counts a field on one thread, it counts every value exactly, including across the partitions of a large index, so the bound there is the largest count that it leaves out. Where it splits the count across worker copies or cluster nodes, each of them returns only its own top values. The merged count of a value that is common overall but rare on one of them can then lack the matches on that one, so the engine adds the largest count that each of them leaves out to the bound.

## Sort

The engine orders the hits by the values of the fields in `sort`, in place of their scores. It compares the fields in the order that you list them, so it uses the second field only to order hits whose first values are equal. Each field takes the direction `asc` or `desc`, and the engine throws `SEARCH_INVALID_MODE` for any other direction. When the hits are equal on every sort field, the engine orders them by document ID.

The engine computes no relevance scores for a sorted query, so it returns each hit without a `score`. Pass `includeScores: true` so that the engine computes the scores and returns each hit with the score that it would have without the sort. For a sorted query that sets `minScore`, the engine still applies that floor, although it returns the scores only where `includeScores` is true.

The engine sorts by a `number`, `boolean`, or `enum` field with no preparation. It sorts by a text field only where the schema declares it `string:sortable`, and it throws `SEARCH_INVALID_FIELD` for a sort on a plain `string` field. It throws the same error for a sort on a `geopoint` or a vector field, because neither type has an order. Where a field holds a list, the engine sorts each document by one value from that list, which is the smallest for an ascending sort and the largest for a descending one, as Elasticsearch does. Set `mode` on a sort entry to choose `'min'`, `'max'`, `'avg'`, or `'median'` yourself. Under the last two, the engine sorts by the mean or the median of a list of numbers, so it throws `SEARCH_INVALID_FIELD` for either of them on a field other than `number` or `number[]`. The engine orders a document whose list is empty after every document that has a value.

```ts
const cheapestFirst = await narsil.query('products', {
  term: 'desk',
  sort: [{ field: 'prices', direction: 'asc' }],
})

const byAveragePrice = await narsil.query('products', {
  term: 'desk',
  sort: [{ field: 'prices', direction: 'desc', mode: 'avg' }],
})
```

The engine compares string values by their Unicode case fold, so it places `apple` between `Apple` and `Banana`. It compares two values with an equal fold by their raw code points, and it compares only the first 512 code points of a value. The engine uses no locale, so it returns the same sorted page on every machine. A sort holds at most eight fields, each with a name of at most 255 characters, because the engine writes one value for each field into the paging cursor.

The engine orders a missing value after every present value, in either direction. Between present values of different types, it orders numbers first, then strings, then booleans.

For the first sorted query on a field, the engine builds a column of that field's values. For every later page, it then selects from that column the documents that follow the cursor anchor. On 120,000 documents on an Apple M-series laptop, the build took 159 ms for short text and 398 ms for values above the 512 code point window, while each later page took 0.1 ms. The engine updates the column on every write, which lowered insert throughput by 12% for one text field and one number field over 119,000 documents.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  sort: { price: 'asc', title: 'asc' },
})
```

Pass a sort as a list where the order of the fields matters, because JavaScript moves an all-digit key such as `2024` to the front of an object.

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

When you set `group`, the engine collapses the hits that share field values into one group for each set of values. It returns up to `maxPerGroup` hits from each group, or one hit where you leave that out, while it returns up to `limit` groups, best first. An optional reducer folds every hit of each group into one value, including the hits beyond `maxPerGroup`, so a reducer that sums a field adds up the whole group. In cluster mode the coordinator fetches up to 10,000 hits of each group for the reducer to fold.

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

For shallow pages, set `limit` and `offset`. For deep pages, pass a `searchAfter` cursor, since the engine then does the same work for each page at any depth. The engine anchors a cursor on the last result of the page, using its score for a relevance-ranked query and its sort values for a sorted one. It returns a `cursor` string with every page, which you pass back as `searchAfter` to fetch the next page.

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

A cursor is valid only for the query that the engine creates it for. The engine binds each cursor to the query's term, fields, filters, match options, and scoring mode, so it throws `SEARCH_INVALID_CURSOR` for a cursor that you send back with a changed query, as it does for a malformed cursor.

The first 10,000 results form the result window, and the engine pages with `offset` and `limit` inside that window alone. It throws `SEARCH_RESULT_WINDOW_EXCEEDED` for a request past that window, while a cursor on a keyword search can page beyond it, because the engine returns each page as the `limit` results that follow the anchor. The engine limits paging to that window, although it still processes every matching document for a sort, a group, a `minScore`, or a `termMatch` other than `any`.

The engine pages a vector search another way. Because it compares the query with only a fraction of the vectors in a field that holds a graph, it can reach the rank in the cursor only by fetching every result above that rank. It therefore fetches every result down to that depth, plus one more page, for each page. Where that depth is beyond the result window, it raises `SEARCH_RESULT_WINDOW_EXCEEDED`. Set a filter or a `similarity` floor on such a search so that fewer vectors qualify, and read [Vector search](vector-search.md#result-totals-and-paging) for the whole rule.

## How the engine counts matches

`count` holds the number of documents that the query matches, before the engine applies `limit` and `offset`. Check `countExact` to find out whether that number is the total or a floor under it.

For a keyword search the engine counts every match, so `countExact` is true. For a vector search it counts every vector that passes the query's filter and its `similarity` floor, which is every vector in the field where the query sets neither of them. That count is exact whenever the engine compares the query with every vector that passes them.

Where the field holds a graph and the query sets a `similarity` floor, the engine compares the query with only a fraction of the field's vectors. `count` then holds the number of vectors that the engine fetches, which is why `countExact` is false. The engine fuses two rankings for a hybrid search, so `countExact` is true there only where each of the two rankings contains every matching document.

```ts
const result = await narsil.query('products', {
  vector: { field: 'embedding', value: myQueryVector, similarity: 0.8 },
  limit: 20,
})

const total = result.countExact ? `${result.count}` : `${result.count} or more`
```

## Pinning

The engine places each `pinned` document at a fixed position in the ranked results, which is how you show a sponsored or editorial placement. The engine counts positions from zero at the top of the whole result set, so it places no pinned document on a page that you reach with `searchAfter`. It anchors a cursor on the last result that is not a placement, so it returns no cursor with a page of placements alone.

The engine also counts in `count` each pinned document that the query does not match, since that document appears among the hits. Where the engine fetches only a fraction of the matches, as it does for a vector search over a field that holds a graph, a pinned document from outside those hits may or may not be a match. The engine then excludes that document from `count` and sets `countExact` to false.

```ts
const results = await narsil.query('products', {
  term: 'keyboard',
  pinned: [{ docId: 'kb-editorial-pick', position: 0 }],
})
```
