---
status: accepted
---

# Every filter test reads an index

The engine answers every filter test from an index that it keeps for the field, so the work of a filter grows with the documents that it matches and with the number of its tests. Before this decision, a test on a field without a suitable index checked the stored value of every document. On the development machine, a filter of 20,000 such tests over 5,000 documents held a server for 8.6 to 12.4 seconds, and the engine set no bound on that time.

The engine keeps an index of values for each `number`, `boolean`, `enum`, and `geopoint` field, and a pattern index for each pattern field. For every declared field, it also records which documents hold a value and how many elements each list holds, which answers `exists`, `notExists`, `isEmpty`, `isNotEmpty`, and `size`. It answers `startsWith` and `endsWith` on an `enum` field through a sorted list of the field's distinct values, beside a second sorted list of the same values with their characters reversed. It places each location in a grid of cells over the globe, ordered by a code that interleaves the latitude cell with the longitude cell, so a `radius` or `polygon` test reads only the cells that cover its shape. It tests a point against a polygon through a balanced tree of the polygon's edges, as Lucene's `Polygon2D` does, so each point takes a walk down the tree in place of a pass over every edge.

The engine refuses each test that none of those indexes can answer. It throws `SEARCH_INVALID_FILTER` for `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `containsAll`, and `matchesAny` on a `string` or `string[]` field whose type leaves out `pattern`. It throws `SEARCH_INVALID_FIELD` for a filter on a field that the schema leaves out, on a strict index and on any other. Meilisearch likewise refuses a filter on an attribute that its settings leave out of the filterable list, while Elasticsearch lets an operator refuse every query that has to check a field without an index.

The engine also limits the size of a filter. A filter holds at most 1,024 tests, which is the least number of clauses that Elasticsearch allows in one query. Each `in`, `nin`, `containsAll`, or `matchesAny` list holds at most 65,536 values, and each polygon at most 65,536 corners, which matches the default limit that Elasticsearch sets on the terms of one terms query. Typesense allows 100 operators in a filter by default.

## Considered options

A count of the work that each search does, in the way that SQLite counts the instructions of a query, bounds the time of any filter. However, the engine would go on checking every document for the tests without an index, while the search engines above answer filters from indexes. A time limit, such as the one that Meilisearch sets on each search, makes the same query pass on a fast machine and fail on a slow one, and it returns partial results, which ADR 0012 rules out. A limit on the number of tests alone leaves the cost of each test growing with the index, so 1,024 tests over a million documents can check about a billion values.

## Consequences

A filter with a whole-value test on a plain text field, or with a test on a field outside the schema, now fails with an error that names the fix, which is to declare the field, or to add `pattern` to its type, in a new index. The record of which documents hold each field adds one entry for each declared field that a document fills. The engine rebuilds that record from the stored documents when it loads a partition, because the `.nrsl` format leaves it out. ADR 0012 said that `startsWith` and `endsWith` go on scanning every document, and this decision replaces that sentence.
