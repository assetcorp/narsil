# Filters, facets, and pagination

The engine narrows and orders the results of a query by its filters, facet counts, sort, grouping, cursor, and pinned hits. [Full-text search](full-text-search.md) holds the rules for matching the terms themselves.

## Filters

You can filter on any field that the schema declares. The comparison operators are `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, and `between`. The string operators are `in`, `nin`, `startsWith`, and `endsWith`, together with `contains`, `wildcard`, and `regex` on a [pattern field](#pattern-tests). The array operators are `containsAll`, `matchesAny`, and `size`, and the presence checks are `exists`, `notExists`, `isEmpty`, and `isNotEmpty`. Combine filter expressions with `and`, `or`, and `not`. On a list field, the engine tests each element with `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `contains`, `wildcard`, and `regex`, so `eq: 'vegan'` matches a document whose list includes `'vegan'`. However, `ne` and `nin` match a document only when the document holds the field and every element of its list differs from the values, which an empty list does. They leave out a document that lacks the field.

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

Put each field condition under `fields`, and nest whole filter expressions inside `and`, `or`, and `not`, so that you can write any boolean shape. The engine throws `SEARCH_INVALID_FILTER` for any other key, so it raises that error for a field name written at the top level, such as `{ category: { eq: 'books' } }`, and for a misspelled operator. It raises the same error for an operand of the wrong shape, such as a `between` with one bound, a `radius` with a negative `distance`, or a `radius` centre or `polygon` corner whose latitude is outside -90 to 90 or whose longitude is outside -180 to 180, for an `and` or `or` clause that is not a list, for an expression nested more than 30 levels deep, and for an operator on a field of another type, such as `startsWith` on a `number` field or `eq: '700'` on one. On a strict index, the engine throws `SEARCH_INVALID_FIELD` for a sort, facet, or group on a field outside the schema, because a strict index refuses every document that holds such a field. The engine scores only the documents that pass the filters. It returns hits for a full-text query only when you set a `term`, while in vector and hybrid modes it compares the query vector with only the documents that pass the filters.

### Indexes behind each test

The engine answers every filter test from an index that it keeps for the field, so the work of each test grows with the number of documents that it matches. A `number`, `boolean`, `enum`, or `geopoint` field keeps an index of its values. The engine finds the points inside a `radius` or a `polygon` through a grid of cells over the globe, so it checks only the points in the cells that cover the shape. For a text or a list field, the engine records which documents hold a value and how many elements each list holds, while for any other field it takes the documents that hold a value from the field's index of values. From those records, it answers `exists`, `notExists`, `isEmpty`, `isNotEmpty`, and `size` on any declared field.

A text field keeps an index of whole values only where it is a `verbatim` field or its type includes `pattern`. The engine therefore throws `SEARCH_INVALID_FILTER` for `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `containsAll`, or `matchesAny` on a `string` or `string[]` field whose type leaves out `pattern`. To test the whole values of such a field, declare it as `string:pattern` or `string[]:pattern` in a new index, where a full-text query matches its words as before. On an `enum` field, the engine finds the matches of `startsWith` and `endsWith` through a sorted list of the field's distinct values.

The engine applies `containsAll`, `matchesAny`, and `size` to list fields alone. The values of `containsAll` and `matchesAny` must have the type of the list's elements, such as numbers for a `number[]` field. The engine throws `SEARCH_INVALID_FIELD` for a filter on a field that the schema leaves out, on every index, because it keeps no index for such a field.

The engine throws `SEARCH_INVALID_FILTER` for a filter that holds more than 1,024 tests, counted across every field and nested expression. Each operator counts as one test, as does each bound of `size`, while `caseFold` and `tolerance` count as none. An expression or a field filter with no test of its own also counts as one, because the engine reads and checks each of them all the same. The engine throws the same error for an `in`, `nin`, `containsAll`, or `matchesAny` list of more than 65,536 values and for a polygon of more than 65,536 corners.

### Text ranges

On a single `string` or `verbatim` field whose type includes `sortable`, the engine can also test `gt`, `gte`, `lt`, `lte`, and `between` against text bounds. In the query below, `between: ['INV-2024', 'INV-2025']` matches every code from `INV-2024` to `INV-2025`, with both bounds included.

```ts
const invoices = await narsil.query('invoices', {
  term: 'invoice',
  filters: { fields: { code: { between: ['INV-2024', 'INV-2025'] } } },
})
```

The engine orders the values as a [sort](#sort) on the field does, comparing their case folds in code point order and comparing their raw code points only where the folds are equal. Under that order, `gte: 'apple'` matches `apple` and `Banana` but not `Apple`, which orders before `apple`. It finds the matching documents with a binary search over the column of sorted values that it keeps for sorting the field. The engine therefore builds that column for the first range test on a field, as it does for the first sort. It throws `SEARCH_INVALID_FILTER` for a text bound on any other field, including a `string[]:sortable` field. It throws that error for a list because it sorts each document's list by one element, so it keeps only that element's position in the sorted column.

### Pattern tests

A pattern field is a `verbatim` or `verbatim[]` field, or a `string` or `string[]` field whose type includes `pattern`. The engine keeps a pattern index for each pattern field. It uses that index to find the documents whose value holds the text of a `contains` test, matches a [wildcard pattern](#wildcard-patterns), or holds a match of a [regular expression](#regular-expressions). In the query below, the engine returns the `checkout` matches whose message holds `connection refused` in any mix of upper and lower case.

```ts
const failures = await narsil.query('logs', {
  term: 'checkout',
  filters: { fields: { message: { contains: 'connection refused', caseFold: true } } },
})
```

With `caseFold: true`, the engine compares the Unicode case fold of each value with the case fold of the text. A test for `error` then matches `ERROR`, in the same way that a test for `strasse` matches `Straße`. `caseFold` applies to `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `contains`, `wildcard`, and `regex` on a pattern field. Without `caseFold`, the engine compares the code points exactly. The engine compares each value as it is stored, with no Unicode normalisation, so `café` with a precomposed `é` and `café` with a combining accent are different values. If your app receives both forms, normalise the text before you insert it.

The pattern index maps each run of three code points in a field's folded values to the documents that hold that run. For a literal test, the engine picks as many as 16 runs across the case fold of the text and takes its candidates from the rarest of them. It then checks each candidate against the whole test. On a pattern field, the engine answers `eq`, `ne`, `in`, `nin`, `startsWith`, and `endsWith` in the same way. On a text field without a pattern index, it refuses those tests, as [Indexes behind each test](#indexes-behind-each-test) explains. The engine can take no run from a text whose case fold is shorter than three code points, so for such a text it checks every document that holds a value in the field.

The engine throws `SEARCH_INVALID_FILTER` in these cases:

- The filter sets `contains`, `wildcard`, `regex`, `caseFold`, or `tolerance` on a field that is not a pattern field.
- The text or the pattern of a test on a pattern field holds more than 1,024 code points.
- A literal test under `caseFold` has a text whose case fold holds more than 2,048 code points.
- A wildcard pattern or a regular expression breaks one of the rules in [Pattern limits](#pattern-limits).

The engine also limits the work that it spends on the pattern tests of one search, counting that work across every partition that it searches. It adds one unit for each run of three code points that it looks up in a pattern index, one unit for each entry that it reads from a pattern index, and one unit for each step of its matcher. A step tests one position of a pattern against one code point. At each code point that the matcher checks, the engine counts one step for each position that a match can reach. The engine counts each literal test as the regular expression that it equals, such as `^text$` for an `eq` test. When it can take no run from a test, it counts each document that it checks as an entry that it reads. That happens for a text whose case fold is shorter than three code points, and for a pattern that holds no run of three literal code points. The engine counts an `in` or `nin` test as one `eq` test for each distinct value in its list. For an `eq` test with a [tolerance](#typos-in-an-eq-test), it counts one step for each cell that it fills in the table of edit distances between the text and a value. It also counts the preparation of that test, adding one step for each code point of the text that it folds, one step for each run of the folded text that it checks for distinctness, and one step for each code point that it copies for the distance computation. The engine counts each distinct test once for a search, however many worker copies prepare it, so it reaches the same count for the same search over the same data at every worker count. For the 1,024 tests that a filter can hold, under the longest fold, the engine counts about 5.25 million units of preparation, which stays inside the default cap. Once the count exceeds the `patternWorkCap` engine setting, which defaults to 25,000,000 units, the engine throws `SEARCH_WORK_CAP_EXCEEDED`. See [Configuration](configuration.md#narsilconfig) for the setting.

A Node process loads the pattern search code by itself. A browser bundle includes that code only when the app imports `patternSearch` and registers it. The app has to register `patternSearch` before it creates or loads an index with a pattern field:

```ts
import { registerPatternSearch } from '@delali/narsil'
import { patternSearch } from '@delali/narsil/pattern'

registerPatternSearch(patternSearch)
```

Without that registration, the engine throws `CONFIG_INVALID` for an index with a pattern field, and the error message tells you which import to add.

### Typos in an eq test

A `tolerance` on an `eq` test of a pattern field lets the test match a value within that many edits of the text as well. An edit inserts, deletes, or replaces one code point, so a swap of two neighbouring code points counts as two edits. In the query below, the text holds the letter O where the order code holds a zero, so the engine returns the order `INV-2024-0042`, which is one edit away from the text.

```ts
const orders = await narsil.listDocuments('orders', {
  filters: { fields: { code: { eq: 'INV-2O24-0042', tolerance: 1 } } },
})
```

A tolerance can be 0, 1, 2, or `'auto'`. With `caseFold`, the engine counts the edits between the case folds of the value and the text, so `inv-2o24-0042` with a tolerance of 1 matches `INV-2024-0042` as well. The engine counts edits with the same distance that it applies in [fuzzy matching](full-text-search.md#fuzzy-matching), although the `tolerance` of a query applies to its terms alone and leaves its filters exact. The tolerance of a filter applies to its `eq` test alone, so the other tests on the field still compare the text exactly.

The engine takes its candidates from the pattern index. A value within `k` edits of the text holds at least one of any `k × (2 + f) + 1` distinct runs of three code points in the case fold of the text, where `f` is the number of code points in the longest case fold among the text's code points. `f` is 1 for most text, while it is 2 for a text that holds `ß`, because `ß` folds to `ss`. From as many as 16 distinct runs that it picks across the case fold of the text, the engine reads the documents of the `k × (2 + f) + 1` runs that the fewest documents hold. It then counts the edits between the text and the value of each of those documents.

The engine therefore needs `k × (2 + f) + 1` distinct runs in the text for a tolerance of `k`. `INV-2O24` holds 6 distinct runs, so the engine accepts a tolerance of 1 on it, which needs 4, while it refuses a tolerance of 2, which needs 7. For a tolerance of 1 or 2 on a text with too few runs, the engine throws `SEARCH_INVALID_FILTER` with a message that states how many runs the tolerance needs. Under `'auto'`, the engine uses 2 where the text holds enough runs for 2, otherwise 1 where it holds enough for 1, and otherwise 0, so the engine never raises that error under `'auto'`. The engine throws `SEARCH_INVALID_FILTER` for any other tolerance, for a tolerance on a field that isn't a pattern field, and for a tolerance in a filter that sets no `eq` test.

### Wildcard patterns

A `wildcard` test matches a value when the whole value matches the pattern. In the pattern, `*` matches any sequence of code points, including an empty one. A `?` matches exactly one code point. Every other code point matches itself. Write `\` before a code point to match that code point itself, so `\*` matches an asterisk and `\\` matches a backslash. In the query below, `INV-*-2024` matches `INV-0042-2024` and `INV--2024`. It doesn't match `INV-2024`, because that value has only one hyphen.

```ts
const invoices = await narsil.listDocuments('orders', {
  filters: { fields: { code: { wildcard: 'INV-*-2024' } } },
})
```

The engine throws `SEARCH_INVALID_FILTER` for a pattern that ends in a `\` with no code point after it.

### Regular expressions

A `regex` test matches a value when some part of the value matches the expression, so `refused` matches `connection refused`. The anchors `^` and `$` match only at the start and at the end of the whole value, never at a line break inside it. Put `^` at the start and `$` at the end of an expression to match the whole value. Every construct of Narsil's own syntax appears in the table below.

| Construct | Meaning |
|-----------|---------|
| `a` | It matches that code point. The code points `\ . \| * + ? { } ( ) [ ] ^ $ < >` have other meanings in the syntax, so the next row shows how to match one of them. |
| `\.` | A `\` followed by an ASCII punctuation mark matches the mark itself, so `\.` matches a full stop. |
| `.` | It matches any one code point, including a line break. |
| `\d`, `\w`, `\s` | `\d` matches an ASCII digit. `\w` matches an ASCII letter, an ASCII digit, or `_`. `\s` matches a tab, a line feed, a form feed, a carriage return, or a space. |
| `[a-z_]`, `[^0-9]` | A set matches one code point that it holds. A set that opens with `^` matches one code point outside the set. A set can hold code points, ranges such as `a-z`, and the classes `\d`, `\w`, and `\s`. Inside a set, write `\-`, `\]`, `\[`, and `\\` to match those code points. |
| `x\|y` | It matches `x` or `y`. |
| `(x)` | A group matches `x`, so `(ab)+` repeats both code points. |
| `x*`, `x+`, `x?` | They match `x` zero or more times, one or more times, or at most once. |
| `x{n}`, `x{n,}`, `x{n,m}` | They match `x` exactly `n` times, at least `n` times, or from `n` to `m` times. |
| `^`, `$` | They match at the start and at the end of the value. |
| `\b` | It matches where a `\w` code point meets a code point outside `\w`, or meets the start or the end of the value. |
| `<low-high>` | It matches the digits of a whole number from `low` to `high`, as the paragraph after the next one explains. |

The engine throws `SEARCH_INVALID_FILTER` for any construct outside that syntax. A back-reference, a lookahead, a lookbehind, a lazy or possessive repeat such as `*?`, an inline flag, a non-capturing group such as `(?:x)`, a Unicode property class, and an escape such as `\n` all fall outside it. The engine throws the same error for a set range or a number range whose low end is above its high end, and for `{n,m}` when `n` is above `m`. A `^` directly after the `[` of a set always makes the set negated, so the engine also throws that error for `[^]`, which holds nothing. In JavaScript, `[^]` matches any code point, so write `.` for that in Narsil. To match a caret, write `\^`.

Each end of a number range holds from 1 to 15 digits. When both ends hold the same number of digits, the range matches a number padded with zeros to that width, so `<007-123>` matches `007`, `080`, and `123`. When the ends hold different numbers of digits, the range matches a number written with no leading zero, so `port=<1-65535>` matches `port=443`, but it doesn't match `port=0443`. Because a number range matches digits only, and a regular expression can match any part of a value, `port=<1-65535>` also matches the `port=9999` inside `port=99999`. To stop the match at the end of the number, put `$` or `\b` after the range.

Under `caseFold`, a literal code point matches its case fold. The `.` and the classes each match one code point of the folded value. A set matches a code point of the folded value when that code point equals the fold of one of the set's members. A set that doesn't open with `^` also matches the whole fold of a member that it holds on its own, when that fold has several code points. So `[ß]` matches `ss`, which means that `stra[ß]e` matches both `Straße` and `STRASSE`. A range in a set always matches exactly one code point.

The matcher never backtracks. It builds the states of a deterministic machine while it reads each value, so it checks a value in at most as many steps as the value's code points multiplied by the pattern's positions. That bound holds however deeply the pattern nests its repeats. The engine takes the candidates for a regular expression or a wildcard pattern from the runs of three code points that every match must hold, such as `INV` and `NV-` in `^INV-\d+$`. When a pattern holds no such run, as `\d{4}` holds none, the engine checks every value of the field. It counts each document that it checks towards the work cap.

### Pattern limits

Before it builds a matcher, the engine throws `SEARCH_INVALID_FILTER` in four cases:

- The pattern holds more than 1,024 code points.
- The groups of the pattern nest more than 32 deep.
- The pattern holds a count above 2,048.
- The pattern holds more than 2,048 positions.

The engine counts the positions of a pattern with these rules:

- A literal code point, `.`, a class, and a set each count as one position, and so do `*` and `?` in a wildcard pattern.
- Under `caseFold`, a literal code point counts once for each code point of its case fold. A set that doesn't open with `^` also adds the code points of each distinct fold that it matches as a sequence.
- `^`, `$`, and `\b` add no positions.
- A repeat multiplies the positions of what it repeats. `*`, `+`, and `?` count those positions once, `{n}` counts them `n` times, `{n,}` counts them `n` times or once, whichever is more, and `{n,m}` counts them `m` times.
- A number range counts the positions of the expression that it stands for, so `<1-65535>` counts 61 positions.

For example, `a{2048}` holds exactly 2,048 positions, so the engine accepts it. `(ab){1025}` holds more than 2,048 positions, and so does `ß{1025}` under `caseFold`, so the engine refuses both.

The matcher holds at most 1 MB of state for one search. When its cache of states fills, it empties the cache and goes on reading. When worker copies split a search, each copy gets an equal share of that 1 MB. The engine therefore splits a search over only as many copies as can each hold the largest pattern in it. An HTTP server can refuse every `regex` test through its `allowRegex` option, as [the HTTP server guide](http-server.md#regular-expressions) explains.

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

Each field's `count` is the number of values that the engine returns for that field, which is at most the facet's `limit`. Its `errorBound` is the most by which any count in `values` can be lower than the true count. A value that the engine leaves out of `values` because of `limit` matches at most that many documents too. Where the engine counts a field on one thread, it counts every value exactly, including across the partitions of a large index, so the bound there is the largest count that it leaves out. Where it splits the count of a highest-first field across worker copies or cluster nodes, each of them returns only its own top values. The merged count of a value that is common overall but rare on one of them can then lack the matches on that one, so the engine adds the largest count that each of them leaves out to the bound. For `ranges` and for `sort: 'asc'`, each of them returns every count, up to 10,000 values from each cluster node, so the merged counts match the counts that one thread produces.

## Sort

The engine orders the hits by the values of the fields in `sort`, in place of their scores. It compares the fields in the order that you list them, so it uses the second field only to order hits whose first values are equal. Each field takes the direction `asc` or `desc`, and the engine throws `SEARCH_INVALID_MODE` for any other direction. When the hits are equal on every sort field, the engine orders them by document ID.

The engine computes no relevance scores for a sorted query, so it returns each hit without a `score`. Pass `includeScores: true` so that the engine computes the scores and returns each hit with the score that it would have without the sort. For a sorted query that sets `minScore`, the engine still applies that floor, although it returns the scores only where `includeScores` is true.

The engine sorts by a `number`, `boolean`, or `enum` field with no preparation. It sorts by a `string`, `verbatim`, `string[]`, or `verbatim[]` field only where the field's type includes `sortable`, as in `string:sortable` or `string[]:sortable`, while it throws `SEARCH_INVALID_FIELD` for a sort on any other field of those types. It throws the same error for a sort on a `geopoint` or a vector field, because neither type has an order. For a list field, the engine sorts each document by one value from its list, which is the smallest for an ascending sort and the largest for a descending one, as Elasticsearch does. Set `mode` on a sort entry to choose `'min'`, `'max'`, `'avg'`, or `'median'` yourself. Under the last two, the engine sorts by the mean or the median of a list of numbers, so it throws `SEARCH_INVALID_FIELD` for either of them on a field other than `number` or `number[]`. The engine orders a document whose list is empty after every document that has a value.

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

For the first sorted query on a field, the engine builds a column of that field's values. For every later page, it then selects from that column the documents that follow the cursor anchor. Once the engine has built a column, it updates that column on every write, so each column that it keeps adds work to every insert.

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

The engine pages a vector search another way. Because it compares the query with only a fraction of the vectors in a field that holds a graph, it can reach the rank in the cursor only by fetching every result above that rank. It therefore fetches every result down to that depth, plus one more page, for each page. Where that depth is beyond the result window, it raises `SEARCH_RESULT_WINDOW_EXCEEDED`. Set a filter or a `similarity` floor on such a search so that fewer vectors qualify, and read [Vector search](vector-search.md#result-totals-and-paging) for the whole rule. A hybrid query that sets `hybrid.depth` pages through that many fused results, which [Hybrid search](hybrid-search.md) describes.

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
