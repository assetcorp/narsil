---
status: accepted
---

# Every filter test reads an index

The engine answers every filter test from an index that it keeps for the field, so the work of each test grows with the number of documents that it matches. Before this decision, a test on a field without a suitable index read the stored value of every document. On the development machine, a server took 8.6 to 12.4 seconds to answer a filter of 20,000 such tests over 5,000 documents, which works out at about 86 to 124 nanoseconds for each value that it read.

The engine keeps an index of values for each `number`, `boolean`, `enum`, and `geopoint` field, and a pattern index for each pattern field. For a text or a list field, it also records which documents hold a value and how many elements each list holds, while for any other field it takes the documents that hold a value from the field's index of values. From those records, it answers `exists`, `notExists`, `isEmpty`, `isNotEmpty`, and `size`. It answers `startsWith` and `endsWith` on an `enum` field through a sorted list of the field's distinct values, beside a second sorted list of the same values with their characters reversed. It places each location in a grid of cells over the globe, ordered by a code that interleaves the latitude cell with the longitude cell, so the engine checks only the points in the cells that cover the shape of a `radius` or a `polygon` test. It keeps the edges of each polygon in a balanced tree ordered by longitude, as Lucene's `Polygon2D` does, so for each point the engine tests only the edges that span the point's longitude.

The engine refuses each test that none of those indexes can answer. It throws `SEARCH_INVALID_FILTER` for `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `containsAll`, and `matchesAny` on a `string` or `string[]` field whose type leaves out `pattern`. It throws `SEARCH_INVALID_FIELD` for a filter on a field that the schema leaves out, on a strict index and on any other. Meilisearch likewise refuses a filter on an attribute that its settings leave out of the filterable list, while Elasticsearch lets an operator refuse every query on a field that has no index.

The engine also limits the size of a filter. A filter holds at most 1,024 tests, which is the least number of clauses that Elasticsearch allows in one query. Each `in`, `nin`, `containsAll`, or `matchesAny` list holds at most 65,536 values, and each polygon at most 65,536 corners, which matches the default limit that Elasticsearch sets on the terms of one terms query. Typesense allows 100 operators in a filter by default.

## Considered options

A count of the work that each search does, in the way that SQLite counts the instructions of a query, bounds the time of any filter. However, the engine will go on reading the stored value of every document for each test without an index, while the search engines above answer filters from indexes. A time limit, such as the one that Meilisearch sets on each search, can make the same query pass on a fast machine and fail on a slow one. It also returns partial results, which ADR 0012 rules out.

## Consequences

A filter with a whole-value test on a plain text field, or with a test on a field outside the schema, now fails with an error that names the fix, which is to declare the field, or to add `pattern` to its type, in a new index. A test that matches every document still does work in proportion to the size of the index, so a filter of 1,024 such tests over a large index does 1,024 times that work. That work sets bits from an index, where the engine read a stored value before, although the project holds no measurement yet of how long it takes at scale. The record of value sizes adds one entry for each text or list field that a document fills. The engine rebuilds that record from the stored documents when it loads a partition, because the `.nrsl` format leaves it out. ADR 0012 said that `startsWith` and `endsWith` go on scanning every document, and this decision replaces that sentence.
