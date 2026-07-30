# Narsil Algorithm Specifications

This document specifies every algorithm Narsil uses. Every implementation must produce identical output for identical input, except where floating-point precision makes that impossible. Each section gives the formula, the parameters, the edge cases, and the behaviour a caller can rely on.

The pseudocode is language-neutral. `List<T>` is an ordered collection of `T` and `Map<K, V>` a mapping from keys to values. Arithmetic operators carry their usual meaning, `XOR` is bitwise exclusive or, `AND` is bitwise and, and a shift written `>>` on an unsigned value fills from the left with zeros. Names such as `uint32` and `float32` describe exact widths, and each implementation maps them to its own types.

---

## BM25 (Best Matching 25)

BM25 is the relevance scoring algorithm behind every full-text query.

### Formula

For a query `Q` holding terms `q1` through `qn`, scored against a document `D`:

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

The `+ 1` inside the logarithm keeps IDF at or above zero even for a term appearing in more than half the documents.

### Multi-Field Scoring

A query that matches a document across several fields scores the sum of the per-field BM25 scores, each multiplied by that field's boost:

```text
total_score = SUM over each field f of
  boost(f) * BM25(Q, D, field = f)
```

Each field uses its own `|D|`, the token count in that field, and its own `avgdl`, the average token count for that field across every document.

### Parameters

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `k1` | 1.2 | 0 to 3 | Controls how fast term frequency saturates |
| `b` | 0.75 | 0 to 1 | Controls document length normalisation |

A higher `k1` gives repeated terms more weight. A `b` of 0 applies no length normalisation, and a `b` of 1 applies it fully. Both are configured per index when the index is created.

### Edge Cases

- **A term in no documents** has `n(qi) = 0`, so IDF is `ln((N + 0.5) / 0.5 + 1)`. The IDF is high, but nothing matches, so the term adds nothing to any score.
- **A term in every document** has `n(qi) = N`, so IDF is `ln(0.5 / (N + 0.5) + 1)`, which is near zero. The term separates nothing.
- **An empty corpus** has `N = 0`, and every document scores 0.
- **A zero-length document** has `|D| = 0`, which reduces the denominator to `k1 * (1 - b)`. With `b` at 1 that denominator is zero, so an implementation must guard against dividing by zero and score the field 0.

### Distributed BM25

Across partitions, BM25 runs in one of three modes.

**Local scoring**, the default, gives each partition its own `N`, `n(qi)`, and `avgdl`. It is fast, and it approximates when partition sizes or term distributions differ.

**DFS**, for distributed frequency statistics, runs in two phases. The first collects `N`, `n(qi)`, and `avgdl` from each partition; the coordinator sums `N` and `n(qi)` and computes a weighted `avgdl`. The second sends those global values back for scoring. The ranking is correct and it costs two round trips.

**Statistics broadcast** has each partition publish its local statistics periodically. The coordinator holds a merged set and every query scores against the latest merge. It costs one round trip and the statistics run slightly behind.

---

## Bounded Levenshtein Distance

Fuzzy matching, meaning typo tolerance, uses the edit distance between two strings: the fewest single-character insertions, deletions, and substitutions that turn `a` into `b`. The computation stops early once the distance passes the tolerance.

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

The early exit is what keeps this cheap: once the smallest value in a row passes the tolerance, the final distance must pass it too, so the remaining rows never need computing.

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `tolerance` | 0 | The largest edit distance accepted. Zero means exact matches only, so typo tolerance is opt-in per query. |
| `prefixLength` | 2 | The number of leading characters that must match exactly. |

`prefixLength` narrows the search: only tokens sharing the same first characters are candidates, which turns a scan of every token into a scan of one prefix bucket.

---

## HNSW (Hierarchical Navigable Small World)

HNSW answers approximate nearest-neighbour queries once the vector count passes the brute-force promotion threshold. The threshold and the promotion process are in [HNSW Promotion](vector-index.md#hnsw-promotion).

### Graph Structure

HNSW builds a proximity graph in layers.

- **Layer 0**, the bottom, holds every vector, and each node connects to up to `M` of its nearest neighbours.
- **Layers 1 upward** each hold a random subset of the layer below, and their connections span longer distances.
- **The top layer** holds the fewest nodes, and every search starts there.

Layer assignment follows an exponential distribution:

```text
layer = floor(-ln(random()) * mL)
where mL = 1 / ln(M)
```

### Insertion

Inserting a vector `v` runs five steps:

1. Draw a random layer level `l` from the exponential distribution above.
2. Start from the graph's current entry point on its topmost layer.
3. For each layer from the top down to `l + 1`, navigate greedily to the node nearest `v` under the chosen metric.
4. For each layer from `minimum(l, top_layer)` down to 0, find the `efConstruction` nearest neighbours to `v` in that layer, connect `v` to the `M` closest of them, and prune any neighbour that now holds more than `M` connections, or more than `2 * M` at layer 0, back to its closest `M` or `2 * M`.
5. When `l` is above the current top layer, make `v` the new entry point.

### Search

Finding the `k` nearest neighbours of a query vector `q`:

1. Start at the entry point on the top layer.
2. For each layer from the top down to layer 1, navigate greedily to the node nearest `q`.
3. At layer 0, keep a candidate set ordered by nearest distance and a result set ordered by farthest distance, both seeded with the node reached from the layer above. Then, while the candidate set holds anything:
   - Take the closest candidate `c`.
   - Stop when `c` is farther from `q` than the farthest result already held.
   - For each unvisited neighbour `n` of `c`, compute its distance to `q`, and add it to both sets when the result set holds fewer than `efSearch` entries or `n` is closer than the farthest result. Drop the farthest whenever the result set exceeds `efSearch`.
4. Return the `k` closest entries from the result set.

### Removal

Removing a vector `v`:

1. In every layer holding `v`, take `v` out of each neighbour's connection list. A neighbour that has lost its only link to a region of the graph may be reconnected to `v`'s other neighbours.
2. When `v` was the entry point, promote the nearest remaining node in its place.

### Parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `M` | 16 | The maximum connections per node per layer |
| `efConstruction` | 200 | The size of the dynamic candidate list during a build |
| `efSearch` | 50 | The size of the dynamic candidate list during a search |

Layer 0 allows `2 * M` connections. A higher `efConstruction` builds a better graph and inserts more slowly. A higher `efSearch` raises recall and answers more slowly, and each query may set its own.

The metrics are defined in [Similarity Functions](#similarity-functions).

### Serialisation

A graph serialises with an array-based node form, which keeps the MessagePack encoding compact. The full schema is in [envelope.md](envelope.md).

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

With a filter set supplied, only vectors whose document ID is in the set can appear in the results, and how selective that filter is decides the strategy:

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

At 3% selectivity on an index of 100,000 vectors the filter admits 3,000 vectors, and a brute-force pass over those is quick. A traversal that fails the filter on 97% of the nodes it reaches costs more, because it pays the traversal on top of the same comparisons.

When an index holds several graphs, the selectivity check runs per graph rather than over the whole index.

### Auto-Promotion

Vector search runs in two tiers: a brute-force linear scan below a configurable promotion threshold, and HNSW at or above it. The promotion process, the threshold, and the construction strategies are in [HNSW Promotion](vector-index.md#hnsw-promotion).

---

## Similarity Functions

Three metrics measure the distance between two vectors, and all three work on arrays of 32-bit floats.

### Cosine Similarity

```text
cosine(a, b) = dot(a, b) / (magnitude(a) * magnitude(b))

where
  dot(a, b)    = SUM over i of a[i] * b[i]
  magnitude(v) = squareRoot(SUM over i of v[i] * v[i])
```

The range is -1 to 1, higher is more similar, and this is the default metric.

Compute `magnitude(v)` when the vector is inserted and store it, so no search recomputes it. When either vector has zero magnitude, return 0.

### Dot Product

```text
dotProduct(a, b) = SUM over i of a[i] * b[i]
```

The range is unbounded and higher is more similar. Use it on vectors already normalised to unit length, where the dot product equals the cosine similarity.

### Euclidean Distance

```text
euclidean(a, b) = squareRoot(SUM over i of (a[i] - b[i]) * (a[i] - b[i]))
```

The range starts at 0 and has no upper bound, and a lower value means more similar. Ranking can skip the square root, because squared distance preserves the order.

---

## Haversine Distance

Haversine gives the great-circle distance between two points on a sphere. It uses the mean Earth radius, and it is fast and accurate over short distances.

```text
a = sin^2((lat2 - lat1) / 2)
  + cos(lat1) * cos(lat2) * sin^2((lon2 - lon1) / 2)
c = 2 * atan2(squareRoot(a), squareRoot(1 - a))
distance = R * c
```

`lat1`, `lon1`, `lat2`, and `lon2` are in radians, converted from degrees by multiplying by PI and dividing by 180. `R` is 6,371,008.8 metres, the mean Earth radius, and the result is in metres.

| Unit | Conversion from metres |
|------|------------------------|
| `km` | distance / 1000 |
| `mi` | distance / 1609.344 |
| `m` | distance unchanged |

Three edge cases matter. Two identical points give 0. Two antipodal points give `PI * R`, half the circumference. Latitude must fall between -90 and 90 and longitude between -180 and 180; a value outside those ranges is a schema validation error at insertion time.

---

## Vincenty Distance

Vincenty gives the geodesic distance between two points on an oblate spheroid, the WGS-84 ellipsoid. It is more accurate than Haversine over long distances and slower, because it iterates.

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

A loop that has not converged after 200 iterations, which happens for nearly antipodal points, falls back to the Haversine formula.

Haversine is the default. Vincenty runs when a geo radius filter sets its high-precision flag. Under about 100 km the two differ by less than 0.3%, and across a continent Vincenty can differ by up to 0.5%.

---

## Point-in-Polygon (Ray Casting)

Geo polygon filters test whether a point lies inside a polygon by casting a horizontal ray from the point to the right and counting the polygon edges it crosses. An odd count puts the point inside, and an even count puts it outside.

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

### Polygon Centroid

The centroid, from the shoelace formula, supports optimisations such as filtering by distance to the centroid before running the full polygon test.

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

Three edge cases matter. A point exactly on an edge counts as outside, which is what ray casting gives at a boundary. A polygon of fewer than three points returns false. A self-intersecting polygon has undefined behaviour, and an implementation may support it under the even-odd rule that ray casting already applies.

---

## CRC32

CRC32 under the IEEE polynomial covers data integrity in `.nrsl` envelopes.

```text
IEEE polynomial: 0xEDB88320 (reflected form)
```

A 256-entry lookup table makes it fast:

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

CRC32 covers the raw payload bytes, after compression when compression is on. The result goes into header bytes 14 to 17 when the checksum flag is set. A reader recomputes it and compares, and a mismatch means corruption and must raise `PERSISTENCE_CRC_MISMATCH`.

---

## FNV-1a Hash

FNV-1a is the fast, non-cryptographic hash behind partition routing, where the partition is `hash(docId) modulo partitionCount`.

```text
fnv1a(input: string) -> uint32
  hash = 2166136261            (the FNV offset basis)
  for each byte of the UTF-8 encoding of input:
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

The empty string returns the offset basis unchanged, because the loop never runs.

FNV-1a is deterministic, so the same input always gives the same output, and it spreads values evenly enough for routing. It is not cryptographically secure, so it must never be used for anything but hash-based routing.

The input must be encoded as UTF-8 bytes before hashing. Every implementation must use that same encoding, or the same document ID routes to different partitions in different languages.

---

## Reciprocal Rank Fusion

RRF is the default hybrid fusion strategy. It combines ranked lists from different search modes, such as BM25 text results and vector similarity results, by fusing on rank position instead of score magnitude.

Given result lists `L1` through `Ln` and a constant `k`:

```text
rrf_score(doc) = SUM over each list Li containing doc of
  1 / (k + rank_Li(doc))
```

`rank_Li(doc)` is the document's rank in list `Li`, counted from 1, so the first document in a list has rank 1.

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `k` | 60 | The constant that damps how much rank position counts |

A higher `k` narrows the gap between adjacent ranks and makes the fusion more even. A lower `k` widens the advantage the top ranks hold.

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
- **A document in one list only** takes a contribution from that list alone, and its contribution from a list it is missing from is 0, which is the same as ranking it infinitely far down.
- **Ties break by document ID**, compared lexicographically, which keeps pagination deterministic.

---

## Scalar Quantisation (SQ8)

SQ8 compresses a float32 vector into uint8 values, cutting the memory a stored vector needs to a quarter. Quantised vectors give fast approximate distances during graph traversal, and the full-precision vectors stay for the final rescoring.

### Quantisation Formula

`alpha` is the step size, the distance in the original value space between two consecutive uint8 values, and `offset` is the value that quantises to zero. Together they reconstruct any stored value:

```text
quantize(v[i])   = clamp(round((v[i] - offset) / alpha), 0, 255)
dequantize(q[i]) = q[i] * alpha + offset
```

Every distance formula below is written in terms of this step size, so a writer must persist `alpha` as the step and never as the range it was derived from.

### Calibration

Calibration derives `alpha` and `offset` from every vector in the store:

```text
calibrate(vectors: List<List<float32>>) -> { alpha: float32, offset: float32 }
  allValues = every dimension of every vector, flattened
  min_val = minimum(allValues)
  max_val = maximum(allValues)

  pad     = (max_val - min_val) * 0.01
  min_val = min_val - pad
  max_val = max_val + pad

  when min_val equals max_val:
    min_val = min_val - 0.001
    max_val = max_val + 0.001

  alpha  = (max_val - min_val) / 255
  offset = min_val
  return { alpha, offset }
```

The bounds widen by one per cent at each end so that values near the extremes keep headroom. When every value in the store is identical the padding is zero, so the bounds separate by a fixed amount instead and `alpha` stays above zero.

Calibration returns nothing when the store holds no vectors, and the caller leaves quantisation switched off until it does.

### Quantised Dot Product

The quantised dot product runs on integers:

```text
sq8DotProduct(a: List<uint8>, b: List<uint8>, dimension: uint16,
              alpha: float32, offset: float32) -> float32
  intSum  = 0
  intSumA = 0
  intSumB = 0
  for i from 0 to dimension - 1:
    intSum  = intSum + a[i] * b[i]
    intSumA = intSumA + a[i]
    intSumB = intSumB + b[i]

  return alpha * alpha * intSum
       + alpha * offset * (intSumA + intSumB)
       + offset * offset * dimension
```

Nothing inside the loop is floating point. The three integer accumulators build in one pass, and three multiplications turn them into the final result.

### Quantised Cosine Similarity

Cosine similarity reads pre-computed sums and sums of squares, so it never has to dequantise a vector to find its magnitude:

```text
sq8Cosine(a: List<uint8>, b: List<uint8>, dimension: uint16,
          alpha: float32, offset: float32,
          sumA: float32, sumSqA: float32,
          sumB: float32, sumSqB: float32) -> float32
  dot  = sq8DotProduct(a, b, dimension, alpha, offset)
  magA = sq8Magnitude(dimension, alpha, offset, sumA, sumSqA)
  magB = sq8Magnitude(dimension, alpha, offset, sumB, sumSqB)
  if magA is 0 or magB is 0:
    return 0
  return dot / (magA * magB)

sq8Magnitude(dimension: uint16, alpha: float32, offset: float32,
             sum: float32, sumSq: float32) -> float32
  value = alpha * alpha * sumSq
        + 2 * alpha * offset * sum
        + dimension * offset * offset
  when value is 0 or below, return 0
  return squareRoot(value)
```

`sum` and `sumSq` are computed from the **quantised** uint8 values of a vector, never from the full-precision values, and a writer stores them that way in `vector_sums` and `vector_sum_sqs`:

```text
sum(q)   = SUM over i of q[i]
sumSq(q) = SUM over i of q[i] * q[i]
```

The magnitude formula expands `dequantize` inside the sum of squares, which is why it needs both accumulators and the dimension. Storing full-precision sums here yields wrong magnitudes and wrong cosine scores.

### Properties

- **Memory.** One byte per dimension replaces four, a fourfold reduction.
- **Speed.** The integer inner loop benefits from SIMD. Without SIMD, SQ8 buys memory rather than speed; with it, the integer loop runs considerably faster than the float32 equivalent.
- **Accuracy.** A global `alpha` and `offset`, shared across every dimension, matches float32 HNSW recall for typical embedding distributions. Accuracy falls off when the value distribution varies sharply between dimensions.

### Recalibration

`compact` recalibrates the SQ8 parameters, so that removing documents cannot leave the quantiser tuned to a distribution the index no longer holds. See [Scalar Quantisation (SQ8)](vector-index.md#scalar-quantisation-sq8).
