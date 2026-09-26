# Narsil Algorithm Specifications

This document specifies every algorithm that Narsil uses. Every implementation must produce identical output for identical input, except where floating-point precision makes that impossible. Each section gives the formula, the parameters, the edge cases, and the behaviour that a caller can rely on.

The pseudocode is language-neutral. `List<T>` is an ordered collection of `T`, and `Map<K, V>` is a mapping from keys to values. Arithmetic operators have their usual meaning, `XOR` is bitwise exclusive or, `AND` is bitwise and, and a shift written `>>` on an unsigned value fills from the left with zeros. Names such as `uint32` and `float32` describe exact widths, and each implementation maps them to its own types.

---

## BM25 (Best Matching 25)

BM25 is the algorithm that scores the relevance of a document to every full-text query.

### Formula

An implementation must score a query `Q`, which holds the terms `q1` through `qn`, against a document `D` as follows:

```text
score(Q, D) = SUM over each query term qi of
  IDF(qi) * (tf(qi, D) * (k1 + 1))
    / (tf(qi, D) + k1 * (1 - b + b * |D| / avgdl))
```

| Symbol | Meaning |
|--------|---------|
| `tf(qi, D)` | Term frequency: how often `qi` appears in `D` |
| `\|D\|` | Document length: the token count of the scored field |
| `avgdl` | The average document length across every document |
| `N` | The total number of documents |
| `n(qi)` | Document frequency: how many documents contain `qi` |
| `k1` | The term saturation parameter, 1.2 by default |
| `b` | The length normalisation parameter, 0.75 by default |

### Inverse Document Frequency

```text
IDF(qi) = ln((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
```

The `+ 1` inside the logarithm keeps IDF at or above zero, even for a term that appears in more than half the documents.

### Multi-Field Scoring

Where a query matches a document across several fields, the document's score is the sum of its per-field BM25 scores, each multiplied by that field's boost:

```text
total_score = SUM over each field f of
  boost(f) * BM25(Q, D, field = f)
```

Each field uses its own `|D|`, the token count in that field, and its own `avgdl`, the average token count for that field across every document.

### Parameters

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `k1` | 1.2 | 0 or above | Controls how fast term frequency saturates |
| `b` | 0.75 | 0 to 1 | Controls document length normalisation |

A higher `k1` gives repeated terms more weight. A `b` of 0 applies no length normalisation, while a `b` of 1 applies it fully. A caller sets both for an index when it creates that index. An implementation must accept a `k1` that is finite and at or above 0 and a `b` from 0 to 1, and it must reject index creation with any other value.

### Edge Cases

- **A term in no documents** has `n(qi) = 0`, so IDF is `ln((N + 0.5) / 0.5 + 1)`. The IDF is high, but nothing matches, so the term adds nothing to any score.
- **A term in every document** has `n(qi) = N`, so IDF is `ln(0.5 / (N + 0.5) + 1)`, which is near zero, and the term ranks no document above another.
- **An empty corpus** has `N = 0`, and every document scores 0.
- **A zero-length document** has `|D| = 0`, which reduces the denominator to `k1 * (1 - b)`. With `b` at 1 that denominator is zero, so an implementation must guard against dividing by zero and score the field 0.

### Distributed BM25

Across partitions, an implementation scores BM25 in one of three modes.

**Local scoring**, the default, gives each partition its own `N`, `n(qi)`, and `avgdl`. It takes one round trip, and its scores are approximate where partition sizes or term distributions differ.

**DFS**, for distributed frequency statistics, takes two phases. In the first phase, the coordinator collects `N`, `n(qi)`, and `avgdl` from each partition, sums `N` and `n(qi)`, and computes a weighted `avgdl`. In the second phase, it sends those global values back to the partitions for scoring. The ranking is exact, and it takes two round trips.

**Statistics broadcast** has each partition publish its local statistics periodically. The coordinator holds a merged set, and every query scores against the latest merge. It takes one round trip, while its statistics can be older than the newest writes.

---

## Bounded Levenshtein Distance

Fuzzy matching, which tolerates typos, uses the edit distance between two strings. That distance is the fewest single-character insertions, deletions, and substitutions that turn `a` into `b`. The computation stops early once the distance passes the tolerance.

```text
boundedLevenshtein(a: string, b: string, tolerance: uint32)
    -> { distance: uint32, withinTolerance: boolean }

  if absolute(length(a) - length(b)) > tolerance:
    return { distance: tolerance + 1, withinTolerance: false }

  matrix = a uint32 grid of size [length(a) + 1][length(b) + 1]
  set matrix[i][0] = i for i from 0 to length(a)
  set matrix[0][j] = j for j from 0 to length(b)

  for i from 1 to length(a):
    rowMin = infinity
    for j from 1 to length(b):
      cost = 0 when a[i-1] equals b[j-1], otherwise 1
      matrix[i][j] = minimum of
        matrix[i-1][j] + 1        (deletion)
        matrix[i][j-1] + 1        (insertion)
        matrix[i-1][j-1] + cost   (substitution)
      rowMin = minimum(rowMin, matrix[i][j])

    if rowMin > tolerance:
      return { distance: tolerance + 1, withinTolerance: false }

  distance = matrix[length(a)][length(b)]
  return { distance, withinTolerance: distance <= tolerance }
```

Once the smallest value in a row passes the tolerance, the final distance must pass it too, so the computation returns before it fills the remaining rows.

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `tolerance` | 0 | The largest edit distance accepted. Zero means exact matches only, so typo tolerance is opt-in per query. |
| `prefixLength` | 2 | The number of leading characters that must match exactly. |

`prefixLength` narrows the search, because only the tokens that share those first characters are candidates, so an implementation scans one prefix bucket in place of every token.

---

## HNSW (Hierarchical Navigable Small World)

HNSW answers approximate nearest-neighbour queries once the vector count passes the brute-force promotion threshold. [HNSW Promotion](vector-index.md#hnsw-promotion) defines the threshold and the promotion process.

### Graph Structure

HNSW builds a proximity graph in layers.

- **Layer 0**, the bottom, holds every vector, and each node connects to up to `2 * M` of its neighbours.
- **Layers 1 upward** each hold a random subset of the layer below, and their connections span longer distances.
- **The top layer** holds the fewest nodes, and every search starts there.

Layer assignment follows an exponential distribution:

```text
layer = floor(-ln(random()) * mL)
where mL = 1 / ln(M)
```

### Insertion

An implementation must insert a vector `v` in five steps:

1. Draw a random layer level `l` from the exponential distribution above.
2. Start from the graph's current entry point on its topmost layer.
3. For each layer from the top down to `l + 1`, navigate greedily to the node nearest `v` under the chosen metric.
4. For each layer from `minimum(l, top_layer)` down to 0, find the `efConstruction` nearest neighbours of `v` in that layer, and connect `v` in both directions to the nodes that `selectNeighbours` returns for them. Where a neighbour then holds more connections than its limit, replace its list with the nodes that `selectNeighbours` returns for that list.
5. When `l` is above the current top layer, make `v` the new entry point.

The limit of a node is `M` connections per layer, and `2 * M` at layer 0. `selectNeighbours` keeps a candidate only where that candidate is nearer to the node than to every neighbour already selected, so that the connections of a node spread across the directions around it.

```text
selectNeighbours(node, candidates: List<node>, limit: uint32) -> List<node>
  selected = an empty list
  for each c in candidates, nearest to node first:
    when selected holds limit entries:
      return selected
    when distance(node, c) < distance(c, s) for every s in selected:
      append c to selected
  return selected
```

### Search

An implementation must find the `k` nearest neighbours of a query vector `q` in four steps:

1. Start at the entry point on the top layer.
2. For each layer from the top down to layer 1, navigate greedily to the node nearest `q`.
3. At layer 0, keep a candidate set ordered by nearest distance and a result set ordered by farthest distance, and seed both with the node that step 2 reaches. Then, while the candidate set holds any entry:
   - Take the closest candidate `c`.
   - Stop when `c` is farther from `q` than the farthest entry of the result set.
   - For each unvisited neighbour `n` of `c`, compute its distance to `q`, and add `n` to both sets when the result set holds fewer than `efSearch` entries or `n` is closer than the farthest result. Drop the farthest entry whenever the result set exceeds `efSearch`.
4. Return the `k` closest entries from the result set.

### Removal

An implementation must remove a vector `v` in two steps:

1. In every layer that holds `v`, take `v` out of the list of each neighbour. Where a neighbour then holds fewer connections than its limit, replace its list with the nodes that `selectNeighbours` returns for its own neighbours and the other neighbours of `v`, and connect each of those nodes back to that neighbour.
2. Where `v` is the entry point, make the live node with the highest top layer the new entry point.

### Parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `M` | 16 | The maximum connections per node per layer |
| `efConstruction` | 200 | The size of the dynamic candidate list during a build |
| `efSearch` | 50 | The size of the dynamic candidate list during a search |

Layer 0 allows `2 * M` connections. A higher `efConstruction` raises the recall of the graph and lengthens each insert. A higher `efSearch` raises recall and lengthens each search, and each query may set its own.

[Similarity Functions](#similarity-functions) defines the metrics.

### Serialisation

An implementation must serialise a graph in an array-based node form, which keeps the MessagePack encoding compact. [envelope.md](envelope.md) holds the full schema.

```text
{
  entry_point:     string   (a docId)
  max_layer:       uint8
  m:               uint8
  ef_construction: uint16
  nodes: List<[
    docId:       string,
    layer:       uint8,
    connections: List<[
      layer_index:  uint8,
      neighbor_ids: List<string>
    ]>
  ]>
}
```

### Filtered Search

Where a caller supplies a filter set, a search must return only vectors whose document ID is in the set, and an implementation must choose its strategy by the selectivity of that filter:

```text
selectivity = size(filterDocIds) / totalVectors

if selectivity < filterThreshold (0.03 by default):
  scan the vectors in filterDocIds by brute force
else:
  traverse the graph with the filter applied during the walk, and
  raise efSearch to make up for the lost connectivity:
    ef = maximum(efSearch, ceiling(k / maximum(selectivity, 0.01)))
    ef = minimum(ef, totalVectors)
```

At 3% selectivity on an index of 100,000 vectors, the filter admits 3,000 vectors, which a brute-force pass scores directly. A walk that fails the filter on 97% of the nodes that it reaches costs more, because it pays for the walk on top of the same comparisons.

When an index holds several graphs, an implementation must check selectivity for each graph.

### Auto-Promotion

A vector index answers a search by a brute-force linear scan below a configurable promotion threshold, and by HNSW at or above it. [HNSW Promotion](vector-index.md#hnsw-promotion) defines the promotion process, the threshold, and the construction strategies.

---

## Similarity Functions

Three metrics measure the distance between two vectors, and all three take arrays of 32-bit floats.

### Cosine Similarity

```text
cosine(a, b) = dot(a, b) / (magnitude(a) * magnitude(b))

where
  dot(a, b)    = SUM over i of a[i] * b[i]
  magnitude(v) = squareRoot(SUM over i of v[i] * v[i])
```

The range is -1 to 1, and a higher value means more similar. Cosine is the default metric.

An implementation should compute `magnitude(v)` when a caller inserts the vector and store it, so that a search reads the stored value. When either vector has zero magnitude, the function must return 0.

### Dot Product

```text
dotProduct(a, b) = SUM over i of a[i] * b[i]
```

The range is unbounded, and a higher value means more similar. Use it on vectors of unit length, where the dot product equals the cosine similarity.

### Euclidean Distance

```text
euclidean(a, b) = squareRoot(SUM over i of (a[i] - b[i]) * (a[i] - b[i]))
```

The range starts at 0 and has no upper bound, and a lower value means more similar. An implementation may rank by the squared distance, because the square root preserves the order.

---

## Haversine Distance

Haversine gives the great-circle distance between two points on a sphere of the mean Earth radius. It takes one closed formula, and [Vincenty Distance](#vincenty-distance) states how far the two results differ.

```text
a = sin^2((lat2 - lat1) / 2)
  + cos(lat1) * cos(lat2) * sin^2((lon2 - lon1) / 2)
c = 2 * atan2(squareRoot(a), squareRoot(1 - a))
distance = R * c
```

`lat1`, `lon1`, `lat2`, and `lon2` are in radians, which an implementation computes from degrees by multiplying by PI and dividing by 180. `R` is 6,371,008.8 metres, the mean Earth radius, and the result is in metres.

| Unit | Conversion from metres |
|------|------------------------|
| `km` | distance / 1000 |
| `mi` | distance / 1609.344 |
| `m` | distance unchanged |

An implementation must accept only these three units in a geo radius filter, and it must reject any other with `SEARCH_INVALID_FILTER`. It must reject a radius whose `distance` is negative or not a finite number with `SEARCH_INVALID_FILTER` as well.

Two identical points give 0, and two antipodal points give `PI * R`, which is half the circumference. Latitude must be from -90 to 90 and longitude from -180 to 180, and an implementation must reject any other value as a schema validation error at insertion.

---

## Vincenty Distance

Vincenty gives the geodesic distance between two points on the WGS-84 ellipsoid, which is an oblate spheroid. It is more accurate than Haversine over long distances, and it takes longer because it iterates.

```text
a = 6378137.0            (semi-major axis in metres)
f = 1 / 298.257223563    (flattening)
b = a * (1 - f)          (semi-minor axis, about 6356752.314 metres)
```

Given two points in radians:

```text
U1 = atan((1 - f) * tan(lat1))
U2 = atan((1 - f) * tan(lat2))
L  = lon2 - lon1

lambda = L   (the first approximation)

repeat until |lambda_new - lambda| < 1e-12, or 200 iterations:

  sin_sigma = squareRoot(
    (cos(U2) * sin(lambda))^2 +
    (cos(U1) * sin(U2) - sin(U1) * cos(U2) * cos(lambda))^2
  )
  cos_sigma = sin(U1) * sin(U2)
            + cos(U1) * cos(U2) * cos(lambda)
  sigma = atan2(sin_sigma, cos_sigma)
  sin_alpha = cos(U1) * cos(U2) * sin(lambda) / sin_sigma
  cos2_alpha = 1 - sin_alpha^2
  cos_2sigma_m = cos_sigma
               - 2 * sin(U1) * sin(U2) / cos2_alpha
    (when cos2_alpha is 0, set cos_2sigma_m to 0)
  C = f / 16 * cos2_alpha * (4 + f * (4 - 3 * cos2_alpha))
  lambda_new = L + (1 - C) * f * sin_alpha * (
    sigma + C * sin_sigma * (
      cos_2sigma_m + C * cos_sigma
        * (-1 + 2 * cos_2sigma_m^2)
    )
  )
  lambda = lambda_new

u2 = cos2_alpha * (a^2 - b^2) / b^2
A = 1 + u2 / 16384
  * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
B = u2 / 1024
  * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
delta_sigma = B * sin_sigma * (
  cos_2sigma_m + B / 4 * (
    cos_sigma * (-1 + 2 * cos_2sigma_m^2) -
    B / 6 * cos_2sigma_m
      * (-3 + 4 * sin_sigma^2)
      * (-3 + 4 * cos_2sigma_m^2)
  )
)

distance = b * A * (sigma - delta_sigma)
```

The result is in metres.

Where the loop reaches 200 iterations without converging, which can happen for nearly antipodal points, an implementation must return the Haversine distance.

Haversine is the default, and an implementation must use Vincenty when a geo radius filter sets its high-precision flag. Under about 100 km the two differ by less than 0.3%, and across a continent they can differ by up to 0.5%.

---

## Point-in-Polygon (Ray Casting)

A geo polygon filter tests whether a point is inside a polygon by casting a horizontal ray from the point to the right and counting the polygon edges that the ray crosses. An odd count means that the point is inside, and an even count means that it is outside.

```text
isPointInPolygon(lat: float64, lon: float64, polygon: List<GeoPoint>) -> boolean
  inside = false
  j = length(polygon) - 1

  for i from 0 to length(polygon) - 1:
    if (polygon[i].lon > lon) differs from (polygon[j].lon > lon):
      slope = (polygon[j].lat - polygon[i].lat)
            / (polygon[j].lon - polygon[i].lon)
      intersectLat = polygon[i].lat
                   + slope * (lon - polygon[i].lon)
      if lat < intersectLat:
        inside = not inside
    j = i

  return inside
```

Where `crossesAntimeridian` returns true for a polygon, an implementation must apply `eastward` to every longitude of the polygon and to the tested longitude before it casts the ray. An implementation that applies this rule matches the area inside a ring whose points are in the counter-clockwise order of an exterior ring under RFC 7946, whether or not that ring crosses the antimeridian.

```text
crossesAntimeridian(polygon: List<GeoPoint>) -> boolean
  west = minimum over i of polygon[i].lon
  east = maximum over i of polygon[i].lon
  A = 0   (twice the signed area)
  j = length(polygon) - 1

  for i from 0 to length(polygon) - 1:
    A = A + polygon[j].lon * polygon[i].lat
          - polygon[i].lon * polygon[j].lat
    j = i

  return east - west >= 180 and A < 0

eastward(lon: float64) -> float64
  when lon < 0: return lon + 360
  return lon
```

### Polygon Centroid

An implementation may compute the centroid with the shoelace formula, so that it can filter by distance to the centroid before it applies the full polygon test.

```text
centroid(polygon: List<GeoPoint>) -> GeoPoint
  A  = 0   (signed area)
  cx = 0
  cy = 0
  n  = length(polygon)

  for i from 0 to n - 1:
    j = (i + 1) modulo n
    cross = polygon[i].lat * polygon[j].lon
          - polygon[j].lat * polygon[i].lon
    A  = A + cross
    cx = cx + (polygon[i].lat + polygon[j].lat) * cross
    cy = cy + (polygon[i].lon + polygon[j].lon) * cross

  A  = A / 2
  cx = cx / (6 * A)
  cy = cy / (6 * A)

  return { lat: cx, lon: cy }
```

An implementation must place a point exactly on an edge outside the polygon, which is the result of ray casting at a boundary. `isPointInPolygon` must return false for a polygon of fewer than three points, and an implementation must reject a geo polygon filter of fewer than three points with `SEARCH_INVALID_FILTER`. The result for a self-intersecting polygon is undefined. An implementation may support such a polygon under the even-odd rule of ray casting.

---

## CRC32

A `.nrsl` envelope protects its data with CRC32 under the IEEE polynomial.

```text
IEEE polynomial: 0xEDB88320 (reflected form)
```

An implementation should compute the checksum through a lookup table of 256 entries:

```text
buildCRC32Table() -> List<uint32>
  table = a uint32 array of 256 entries
  for i from 0 to 255:
    crc = i
    for bit from 0 to 7:
      if crc AND 1 is nonzero:
        crc = (crc >> 1) XOR 0xEDB88320
      else:
        crc = crc >> 1
    table[i] = crc
  return table

crc32(data: bytes) -> uint32
  table = the cached table
  crc = 0xFFFFFFFF
  for each byte in data:
    crc = (crc >> 8) XOR table[(crc XOR byte) AND 0xFF]
  return crc XOR 0xFFFFFFFF
```

Every shift above is a logical shift on a 32-bit unsigned value, filling from the left with zeros.

### Test Vectors

| Input | CRC32 |
|-------|-------|
| empty bytes | `0x00000000` |
| ASCII `123456789` | `0xCBF43926` |

A writer must compute CRC32 over the raw payload bytes, after compression when compression is on, and it must store the result in header bytes 14 to 17 when it sets the checksum flag. A reader must recompute the checksum and raise `PERSISTENCE_CRC_MISMATCH` where the two values differ.

---

## FNV-1a Hash

FNV-1a is the non-cryptographic hash that partition routing uses, where the partition is `hash(docId) modulo partitionCount`, and that [cursor binding](partitioning.md#cursor-binding) uses.

```text
fnv1a(input: bytes) -> uint32
  hash = 2166136261            (the FNV offset basis)
  for each byte of input:
    hash = hash XOR byte
    hash = hash * 16777619     (the FNV prime)
    hash = hash AND 0xFFFFFFFF (keep 32 bits)
  return hash
```

### Test Vectors

| Input | FNV-1a |
|-------|--------|
| empty string | `0x811C9DC5` |
| ASCII `foobar` | `0xBF9CF968` |

The empty string returns the offset basis unchanged, because the loop has no byte to process.

FNV-1a is deterministic, so the same input always gives the same output, and it spreads values evenly enough for routing. An implementation must use FNV-1a for hash-based routing and cursor binding alone, because it offers no cryptographic security.

An implementation must hash a string as its UTF-8 bytes, because any other encoding would route one document ID to different partitions in different languages.

---

## String Ordering

Narsil orders strings with the two comparisons that this section defines, and with those alone. Neither comparison reads a locale, a collation library, or any other host state, so every implementation on every machine produces the same order for the same input.

### Code Point Order

Code point order compares two strings position by position through their Unicode code points. The first position where they differ decides the order, and the lower code point orders first. When one string is a prefix of the other, the shorter orders first. Two strings are equal only when their code points are identical.

Comparing the UTF-8 encodings of two strings byte by byte gives the same order, so an implementation whose strings are UTF-8 may compare raw bytes.

A supplementary character encodes in UTF-16 as a surrogate pair whose units compare below the code points U+E000 to U+FFFF. An implementation whose strings are UTF-16 must therefore adjust the two units at the first differing position before it compares them:

```text
adjust(unit: uint16) -> uint16
  when unit is below 0xD800, return unit
  when unit is below 0xE000, return unit + 0x2000
  return unit - 0x800
```

### Where Each Order Applies

An implementation must compare document IDs in code point order everywhere, which covers result tiebreaks, cursor anchors, merges, and the default listing order. It must compare an ID raw, with no folding and no normalisation, so two distinct IDs never compare equal.

Every tie on a rank key breaks the same way. Results that share a score order by document ID, facet buckets that share a count order by bucket value, and suggestions that share a document frequency order by term, each ascending in code point order. A truncation to a limit must keep the entries that order first under this rule, so that the kept entries are independent of insertion order.

The sort value order below applies to the fields that a query or a listing names in its `sort`.

A caller may sort by a `number`, a `boolean`, or an `enum` field with no preparation. A caller may sort by a `string` field only where the schema marks that field sortable, and an implementation must raise `SEARCH_INVALID_FIELD` for a sort on an unmarked `string` field, because ordering free text takes more memory per document than ordering a scalar. An implementation must raise `SEARCH_INVALID_FIELD` for a sort on a `geopoint` or a vector field, because neither type has an order. A caller may set a mode of `min`, `max`, `avg`, or `median` on a sort field. Where a caller sets no mode, an implementation must use `min` for direction `asc` and `max` for direction `desc`. Where a document's value for a sort field is an array, an implementation must compare one value from that array. Under `min` that value is the present element that orders first in direction `asc` under the rules below, and under `max` it is the element that orders last. Under `avg` it is the mean of the array's finite numbers, and under `median` it is their median, where the median of an even count is the mean of the two middle numbers. An array that holds no such value counts as missing. An implementation must compare a value that is not an array as it is, under every mode. An implementation must raise `SEARCH_INVALID_MODE` for a direction other than `asc` and `desc`, and for any other mode, and `SEARCH_INVALID_FIELD` for `avg` or `median` on a field that the schema declares as a type other than `number` or `number[]`.

An implementation must rank a query that names a sort by sort values alone, and it must skip relevance scoring. Where `includeScores` is true, it must score each hit as it would without the sort. A sorted query that holds a score threshold must compute scores to apply that floor, and it must report them only where `includeScores` is true. A hit that the implementation returns without scoring holds no score.

### Sort Value Order

A sort compares two documents field by field, in the order in which the sort names its fields, and the first field that separates them decides the order. Within one field:

1. A missing value orders after every present value, in ascending and in descending direction alike. An absent field, a null, an array with no value under the field's mode, an object, and a number that is not finite each count as missing. Two missing values are equal.
2. Present values of different types order by type: numbers, then strings, then booleans.
3. Numbers compare numerically. Booleans compare with false first. Strings compare as defined below.
4. A field with direction `desc` reverses the outcome of steps 2 and 3. Step 1 is exempt, so a missing value stays last under either direction.

Two documents that every sort field leaves equal order by document ID, ascending in code point order, whatever the sort directions.

A string sort value is the first 512 code points of the string, and the comparison ignores the rest. Two string values compare by their case folds in code point order, and by their raw code points when the folds are equal. Folding first keeps `apple` and `Banana` in the order that a reader expects, while the raw comparison on a folded tie keeps `Apple` and `apple` distinct.

### Case Folding

The fold is Unicode full case folding, which is the set of mappings in `CaseFolding.txt` with status `C` or `F`, pinned at Unicode 17.0.0. That set holds 1,585 mappings, of which 104 map to more than one code point and none maps to more than three. A code point with no mapping folds to itself. Folding is context-free, because each code point folds alone wherever it appears, so an implementation may fold lazily while it compares.

Folding differs from lowercasing, because lowercasing `ΣΊΣΥΦΟΣ` ends in the final sigma `ς`, while folding maps every sigma to `σ`. An implementation must therefore fold from the table alone.

Folding serves ordering alone, so a stored value, an analysed token, and every byte on disk or on the wire stay as they are.

The fold table is part of this specification, and every implementation must include it. Changing the table is a breaking change to the specification's major version, so the registration check in [Node Registration](distribution/cluster.md#version) keeps engines with different tables out of one cluster. Unicode guarantees that a folding stays fixed once its character is assigned, so a table that an implementer regenerates from a later Unicode version differs only for characters that the earlier version leaves unassigned.

### Test Vectors

Folding:

| Input | Code points | Folded | Code points |
|-------|-------------|--------|-------------|
| `apple` | U+0061 U+0070 U+0070 U+006C U+0065 | `apple` | unchanged |
| `Straße` | U+0053 U+0074 U+0072 U+0061 U+00DF U+0065 | `strasse` | U+0073 U+0074 U+0072 U+0061 U+0073 U+0073 U+0065 |
| `ẞ` | U+1E9E | `ss` | U+0073 U+0073 |
| `ﬃ` | U+FB03 | `ffi` | U+0066 U+0066 U+0069 |
| `İ` | U+0130 | `i` + combining dot | U+0069 U+0307 |
| `ΣΊΣΥΦΟΣ` | U+03A3 U+038A U+03A3 U+03A5 U+03A6 U+039F U+03A3 | `σίσυφοσ` | U+03C3 U+03AF U+03C3 U+03C5 U+03C6 U+03BF U+03C3 |

Code point order, listed ascending:

```text
""  <  "B"  <  "a"  <  "doc-1"  <  "doc-10"  <  "doc-2"  <  U+FF61  <  U+1F600
```

The adjustment exists for the last pair, because an unadjusted UTF-16 comparison puts U+1F600 first, since its high surrogate 0xD83D compares below 0xFF61.

Sort value order for strings, listed ascending:

```text
""  <  "Apple"  <  "apple"  <  "Banana"  <  "FUSS"  <  "Fuß"  <  "fuss"  <  "Zebra"  <  "école"
```

`Apple` precedes `apple` because their folds are equal and the raw comparison decides. `FUSS`, `Fuß`, and `fuss` are adjacent because all three fold to `fuss`. `école` orders last because `é` folds to itself and U+00E9 is above `z`.

An implementation must reproduce both lists exactly.

---

## Reciprocal Rank Fusion

RRF is the default hybrid fusion strategy. It combines ranked lists from different search modes, such as BM25 text results and vector similarity results, by rank position.

An implementation must score each document from the result lists `L1` through `Ln` and a constant `k`:

```text
rrf_score(doc) = SUM over each list Li containing doc of
  1 / (k + rank_Li(doc))
```

`rank_Li(doc)` is the document's rank in list `Li`, counted from 1, so the first document in a list has rank 1.

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `k` | 60 | The constant that lowers the weight of the top ranks |

A higher `k` narrows the gap between adjacent ranks, while a lower `k` widens the advantage that the top ranks hold.

```text
reciprocalRankFusion(lists: List<List<ScoredDoc>>, k: uint32) -> List<ScoredDoc>
  scores = an empty Map<string, float64>

  for each list L in lists:
    for each doc in L, with rank counted from 1:
      scores[doc.id] = (scores[doc.id] or 0) + 1 / (k + rank)

  return the entries of scores, ordered by score, highest first
```

Three properties follow:

- **RRF needs no normalisation.** BM25 scores and cosine similarities have different distributions, and their rank positions compare directly.
- **A document in one list alone** receives the contribution of that list, while every other list contributes 0.
- **Ties break by document ID**, compared in [code point order](#code-point-order), which keeps pagination deterministic.

---

## Optimised Scalar Quantisation (OSQ)

OSQ quantises each vector against a centroid, over an interval that it fits to that vector, as Lucene's optimised scalar quantisation does. A document code holds 8, 4, 2, or 1 bits per dimension for `osq8`, `osq4`, `osq2`, or `osq1`, and a query code holds `QUERY_BITS[bits]` bits per dimension.

### Centroid

Calibration computes the centroid from every vector in the store, then quantises each vector against that centroid. An index that holds no vector skips calibration.

```text
centroid(vectors: List<List<float32>>, metric) -> List<float32>
  sums = a list of dimension zeros
  for each v in vectors:
    when metric is cosine:
      v = unitNormalise(v)
    sums = sums + v
  c = sums divided by the number of vectors
  when metric is cosine:
    c = unitNormalise(c)
  return c

unitNormalise(v: List<float32>) -> List<float32>
  when magnitude(v) is 0:
    return v
  return v divided by magnitude(v)
```

### Quantisation

`dimension` is the number of components in every vector. `clamp(t, low, high)` returns `minimum(maximum(t, low), high)`. [Similarity Functions](#similarity-functions) defines `dot` and `magnitude`.

```text
GRID       = { 1: 0.798, 2: 1.493, 4: 2.514, 8: 3.922 }
STEPS      = { 1: 1, 2: 3, 4: 15, 8: 255 }
QUERY_BITS = { 1: 4, 2: 4, 4: 4, 8: 8 }
LAMBDA     = 0.1

OSQCode {
  codes:      List<uint8>   (one level per dimension)
  lower:      float32
  upper:      float32
  correction: float32
  sum:        uint32
}

quantize(v: List<float32>, c: List<float32>, bits: uint8, metric) -> OSQCode
  when metric is cosine:
    v = unitNormalise(v)
  x = v - c
  when metric is euclidean:
    correction = dot(x, x)
  otherwise:
    correction = dot(v, c)
  mean  = (SUM over i of x[i]) / dimension
  std   = squareRoot((SUM over i of (x[i] - mean) * (x[i] - mean)) / dimension)
  lower = clamp(mean - GRID[bits] * std, minimum(x), maximum(x))
  upper = clamp(mean + GRID[bits] * std, minimum(x), maximum(x))
  lower, upper = refine(x, lower, upper, STEPS[bits])
  for i from 0 to dimension - 1:
    codes[i] = level(x[i], lower, upper, STEPS[bits])
  return { codes, lower, upper, correction, sum: SUM over i of codes[i] }

level(t: float32, lower: float32, upper: float32, steps: uint8) -> uint8
  when upper equals lower:
    return 0
  return floor((clamp(t, lower, upper) - lower) * steps / (upper - lower) + 0.5)

refine(x: List<float32>, lower: float32, upper: float32, steps: uint8) -> lower, upper
  norm = dot(x, x)
  when norm is 0 or upper equals lower:
    return lower, upper
  best = loss(x, lower, upper, steps, norm)
  repeat 5 times:
    daa = dab = dbb = dax = dbx = 0
    for i from 0 to dimension - 1:
      s   = level(x[i], lower, upper, steps) / steps
      daa = daa + (1 - s) * (1 - s)
      dab = dab + (1 - s) * s
      dbb = dbb + s * s
      dax = dax + x[i] * (1 - s)
      dbx = dbx + x[i] * s
    m0  = (1 - LAMBDA) * dax * dax / norm + LAMBDA * daa
    m1  = (1 - LAMBDA) * dax * dbx / norm + LAMBDA * dab
    m2  = (1 - LAMBDA) * dbx * dbx / norm + LAMBDA * dbb
    det = m0 * m2 - m1 * m1
    when det is 0:
      return lower, upper
    a = (m2 * dax - m1 * dbx) / det
    b = (m0 * dbx - m1 * dax) / det
    when absolute(a - lower) < 1e-8 and absolute(b - upper) < 1e-8:
      return lower, upper
    candidate = loss(x, a, b, steps, norm)
    when candidate > best:
      return lower, upper
    lower, upper, best = a, b, candidate
  return lower, upper

loss(x: List<float32>, lower: float32, upper: float32, steps: uint8, norm: float32) -> float64
  xe = e = 0
  for i from 0 to dimension - 1:
    q  = lower + (upper - lower) * level(x[i], lower, upper, steps) / steps
    xe = xe + x[i] * (x[i] - q)
    e  = e + (x[i] - q) * (x[i] - q)
  return (1 - LAMBDA) * xe * xe / norm + LAMBDA * e
```

A search must quantise the query with `quantize(query, c, QUERY_BITS[bits], metric)`. An implementation may compute a code at float32 or wider precision, so two implementations may write different codes for one vector.

### Packing

A code holds its packed levels beside its `lower`, `upper`, `correction`, and `sum`. A writer must pack `8 / bits` levels into each byte, in dimension order, so a code spans `ceiling(dimension * bits / 8)` bytes. Level `i` takes `bits` bits of byte `floor(i * bits / 8)`, from bit `(i mod (8 / bits)) * bits` upwards, where bit 0 is the least significant. A writer must leave 0 in every bit after the last level.

### Estimated Similarity

```text
estimate(d: OSQCode, q: OSQCode, bits: uint8, c: List<float32>, metric) -> float32
  dStep   = (d.upper - d.lower) / STEPS[bits]
  qStep   = (q.upper - q.lower) / STEPS[QUERY_BITS[bits]]
  centred = d.lower * q.lower * dimension
          + q.lower * dStep * d.sum
          + d.lower * qStep * q.sum
          + dStep * qStep * (SUM over i of d.codes[i] * q.codes[i])
  when metric is euclidean:
    return squareRoot(maximum(0, d.correction + q.correction - 2 * centred))
  similarity = centred + d.correction + q.correction - dot(c, c)
  when metric is cosine:
    return clamp(similarity, -1, 1)
  return similarity
```

Every level product is an integer, so an implementation may add the products up from the packed bytes in any order. A search ranks candidates by `estimate` and then re-scores the nearest of them against their full-precision vectors, as [search](vector-index.md#searchquery-k-options) defines.
