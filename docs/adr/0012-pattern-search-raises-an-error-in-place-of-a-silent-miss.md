---
status: accepted
---

# Pattern search raises an error in place of a silent miss

In every case where pattern search can return fewer matches than exist, the engine raises an error and states in its message the limit that applies and the way past it. A developer therefore meets the limit while building, before any user misses a result. By contrast, some search engines keep an over-long value in the document but leave it out of the index, so the value never matches a search. Some also return whatever results they have when a search fails part of the way through, unless the caller forbids partial results. With a quiet miss of that kind, the user sees fewer results, while the developer receives no sign of the limit that caused it.

The engine raises an error for a document whose value in a pattern field is longer than 8,192 code points. A caller can raise that limit to at most 65,536 through an index setting. With values of at most 8,192 code points and patterns of at most 2,048 states, the check of one value stays within 16.8 million steps, so the engine can always check any single value inside the default work cap of 25 million. At the measured 6.0 bytes per character, a value at the limit adds at most about 48 KB of index while its segment grows.

The engine applies `contains`, `wildcard`, and `regex` to pattern fields alone, and it raises an error for those tests on any other field. Without the pattern index, the engine has to check every value of the field. On 100,000 article texts, a full check took between 32 and 206 million steps, depending on the pattern, so a search on a field without the index can start to fail at the work cap somewhere between about 12,000 and 77,000 documents. `startsWith` and `endsWith` go on scanning every document, as they do today.

The engine raises an error for a typo test whose query is too short for its `tolerance`, and it includes the minimum query length for that tolerance in the error. A query is long enough for k typos once it has at least k × (2 + f) + 1 distinct runs of three characters, where f is the number of characters in the longest case fold among the query's characters, as ADR 0011 explains. With `tolerance: 'auto'`, the engine uses the largest tolerance for which the query is long enough.

The engine evaluates `gt`, `gte`, `lt`, `lte`, and `between` on text only for single-value fields marked `:sortable`, through a binary search over the sorted values, and it raises an error for those tests on any other text field. For a list field, the engine sorts each document by its smallest or largest element alone, so the sorted order cannot show whether another element is inside the range.

A search that passes the work cap fails as a whole. A cluster coordinator returns partial results by default when a node fails or times out. However, the coordinator rejects the whole query for every error code on its list of query rejections. Narsil adds the work-cap error to that list, so a cluster returns no partial answer to a search that passes the cap.

The spec will require an implementation that reopens an index from disk to raise an error for any field type that it does not know. Today the TypeScript implementation checks every field type when it restores a snapshot, but it reopens an index from disk without that check. The spec also lets an older reader ignore a stored setting that it does not know. Under that combination, an older version can open an index that has a pattern field and save it again without the pattern index, so a newer version then returns too few matches with no error. An implementation that finds a pattern field without its pattern index rebuilds that index from the stored documents.

## Considered options

Skipping an over-long value, scanning a field that has no pattern index, lowering a tolerance that a query is too short for, and returning partial results each follow a practice of at least one established engine. Under every one of them, however, a user gets fewer results with no error. The engine has both a value-length cap and a work cap, because each one limits a cost that the other leaves open. Without the work cap, a broad pattern checked against many values has no bound on its time, while without the value-length cap, the check of a single long value can use the whole work cap.

## Consequences

A developer meets these errors while building. The way past each one is to raise a limit, to mark a field for pattern search, or to lengthen a query. The spec will define a new client-facing error code for a search that passes the work cap, for which the server will return HTTP 400, as it does for the other search errors. The other errors use codes that exist today: `DOC_VALIDATION_FAILED` for an over-long value and `SEARCH_INVALID_FILTER` for each refused test, both of which the server returns as HTTP 400. Raising the value limit to 65,536 code points lets the check of one value reach 134 million steps with a 2,048-state pattern, which is above the default work cap, so a deployment that raises the limit may have to raise the cap as well. Refusing an unknown field type on reopen closes a gap that exists today for every new field type.
