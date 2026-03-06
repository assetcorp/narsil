# Narsil Algorithm Specifications

This document formally specifies every algorithm used by Narsil. All
implementations (TypeScript, Rust, Python, Go) must produce identical
output for identical input, except where floating-point precision
differences are unavoidable. Each algorithm section includes the
formula, parameters, edge cases, and expected behavior.

---

## BM25 (Best Matching 25)

BM25 is Narsil's primary full-text relevance scoring algorithm.

### BM25 Formula

For a query `Q` containing terms `q1, q2, ..., qn` and a document `D`:

```text
score(Q, D) = SUM for each query term qi:
  IDF(qi) * (tf(qi, D) * (k1 + 1))
    / (tf(qi, D) + k1 * (1 - b + b * |D| / avgdl))
```

Where:

| Symbol | Definition |
| --- | --- |
| `tf(qi, D)` | Term frequency: times `qi` appears in `D` |
| `\|D\|` | Document length: token count in scored field |
| `avgdl` | Average document length across all documents |
| `N` | Total number of documents |
| `n(qi)` | Document frequency: documents containing `qi` |
| `k1` | Term saturation parameter (default: 1.2) |
| `b` | Length normalization parameter (default: 0.75) |

### IDF (Inverse Document Frequency)

```text
IDF(qi) = log((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
```

The `+ 1` inside the logarithm ensures IDF is always non-negative,
even when a term appears in more than half the documents.

### Multi-field Scoring

When a query matches a document across multiple fields, the final
score is the sum of per-field BM25 scores, each multiplied by the
field's boost factor:

```text
total_score = SUM for each field f:
  boost(f) * BM25(Q, D, field=f)
```

Each field uses its own `|D|` (token count in that field) and `avgdl`
(average token count across all documents for that field).

### BM25 Parameters

| Parameter | Default | Range  | Effect                                    |
|-----------|---------|--------|-------------------------------------------|
| `k1`      | 1.2     | [0, 3] | Controls term frequency saturation        |
| `b`       | 0.75    | [0, 1] | Controls document length normalization    |

Higher `k1` gives more weight to repeated terms. `b = 0` means no
length normalization; `b = 1` means full normalization. Both are
configurable per index at creation time.

### BM25 Edge Cases

- **Term in zero documents:** `n(qi) = 0`.
  IDF = `log((N + 0.5) / (0.5) + 1)`. High IDF, but no documents
  match, so this term contributes nothing to any document's score.
- **Term in all documents:** `n(qi) = N`.
  IDF = `log((0.5) / (N + 0.5) + 1)`. Close to zero; the term is
  not discriminative.
- **Empty corpus:** `N = 0`. Return score 0 for all documents.
- **Zero-length document:** `|D| = 0`. The denominator reduces to
  `k1 * (1 - b)`. If `b = 1`, the denominator is 0; implementations
  must guard against division by zero (return score 0 for this field).

### Distributed BM25

In a partitioned system, BM25 can operate in three modes:

**Local scoring** (default): Each partition uses its own `N`, `n(qi)`,
and `avgdl`. Fast but approximate when partition sizes or term
distributions vary.

**DFS (Distributed Frequency Statistics)**: Two-phase query. Phase 1
collects `{ N, n(qi), avgdl }` from each partition. The coordinator
computes global values by summing `N` and `n(qi)` and computing
weighted `avgdl`. Phase 2 sends the global statistics to each
partition for scoring. Correct ranking, two round trips.

**Statistics broadcast**: Each partition periodically publishes its
local statistics. The coordinator maintains a merged global statistics
object. Queries use the latest merged statistics. One round trip,
slightly stale.

---

## Bounded Levenshtein Distance

Used for fuzzy matching (typo tolerance). Computes the minimum number
of single-character edits (insertions, deletions, substitutions) needed
to transform string `a` into string `b`, with early termination when
the distance exceeds a tolerance bound.

### Levenshtein Algorithm

Standard dynamic programming matrix with bounded evaluation:

```text
function boundedLevenshtein(a, b, tolerance):
  if abs(len(a) - len(b)) > tolerance:
    return { distance: tolerance + 1, withinTolerance: false }

  let matrix = Array[len(a) + 1][len(b) + 1]
  initialize matrix[i][0] = i for i in 0..len(a)
  initialize matrix[0][j] = j for j in 0..len(b)

  for i in 1..len(a):
    rowMin = infinity
    for j in 1..len(b):
      cost = 0 if a[i-1] == b[j-1] else 1
      matrix[i][j] = min(
        matrix[i-1][j] + 1,      // deletion
        matrix[i][j-1] + 1,      // insertion
        matrix[i-1][j-1] + cost   // substitution
      )
      rowMin = min(rowMin, matrix[i][j])

    if rowMin > tolerance:
      return { distance: tolerance + 1, withinTolerance: false }

  distance = matrix[len(a)][len(b)]
  return { distance, withinTolerance: distance <= tolerance }
```

### Key Optimization

Early termination: if the minimum value in any row exceeds the
tolerance, the final distance must also exceed it. Skip remaining rows.

### Levenshtein Parameters

| Parameter      | Default | Description                                  |
|----------------|---------|----------------------------------------------|
| `tolerance`    | 1       | Maximum edit distance. 0 = exact match only. |
| `prefixLength` | 2       | Characters that must match exactly first.    |

The `prefixLength` optimization limits the search space: only tokens
sharing the same first N characters are candidates for fuzzy matching,
reducing the comparisons from O(total\_tokens) to
O(prefix\_bucket\_size).

---

## HNSW (Hierarchical Navigable Small World)

HNSW is an approximate nearest neighbor (ANN) algorithm used for vector
similarity search when the vector count exceeds the brute-force
threshold (~10,000 vectors).

### Graph Structure

HNSW constructs a multi-layered proximity graph:

- **Layer 0 (bottom):** Contains all vectors. Each node connects to
  up to `M` nearest neighbors.
- **Layer 1 through L:** Each higher layer contains a random subset
  of nodes from the layer below. Connections span larger distances.
- **Top layer:** Contains the fewest nodes. Serves as the entry
  point for search.

Layer assignment follows an exponential distribution:

```text
layer = floor(-log(random()) * mL)
where mL = 1 / log(M)
```

### Construction (Insertion)

When inserting a vector `v`:

1. Assign a random layer level `l` using the exponential distribution.
2. Set the entry point to the current graph's entry point at the
   topmost layer.
3. For each layer from the top down to `l + 1`:
   - Greedily navigate to the nearest node to `v` (using the chosen
     similarity metric).
4. For each layer from `min(l, top_layer)` down to 0:
   - Find the `efConstruction` nearest neighbors to `v` in this layer.
   - Connect `v` to the `M` closest among them.
   - For each neighbor, if it now has more than `M` connections (or
     `2*M` at layer 0), prune to the `M` (or `2*M`) closest.
5. If `l` is greater than the current top layer, update the entry
   point to `v`.

### HNSW Search

For a query vector `q`, returning the `k` nearest neighbors:

1. Start at the entry point on the top layer.
2. For each layer from the top down to layer 1:
   - Greedily navigate to the nearest node to `q`.
3. At layer 0:
   - Maintain a candidate set (min-heap by distance) and a result set
     (max-heap by distance), both initialized with the entry node from
     the layer above.
   - While the candidate set is not empty:
     - Pop the closest candidate `c`.
     - If the distance from `c` to `q` is greater than the farthest
       result, stop.
     - For each neighbor `n` of `c`:
       - If `n` hasn't been visited:
         - Compute distance from `n` to `q`.
         - If the result set has fewer than `efSearch` entries, or `n`
           is closer than the farthest result, add `n` to both sets.
         - If the result set exceeds `efSearch`, remove the farthest.
   - Return the `k` closest from the result set.

### Node Removal

When removing a vector `v`:

1. For each layer containing `v`:
   - For each neighbor `n` of `v`:
     - Remove `v` from `n`'s connection list.
     - Optionally reconnect `n` to `v`'s other neighbors if `n` lost
       its only connection to a region of the graph.
2. If `v` was the entry point, select the nearest remaining node as
   the new entry point.

### HNSW Parameters

| Parameter        | Default | Description                             |
|------------------|---------|-----------------------------------------|
| `M`              | 16      | Max connections per node per layer      |
| `efConstruction` | 200     | Dynamic candidate list during build     |
| `efSearch`       | 50      | Dynamic candidate list during search    |

Layer 0 uses `2*M` connections. Higher `efConstruction` produces better
graph quality but slower insertion. Higher `efSearch` produces better
recall but slower queries. `efSearch` is configurable per query.

### Similarity Metrics

See the [Similarity Functions](#similarity-functions) section below.

### HNSW Serialization

The HNSW graph serializes using an array-based node format for compact
MessagePack encoding (see [envelope.md](envelope.md) for the full
schema):

```text
{
  entry_point:     string (docId)
  max_layer:       uint8
  m:               uint8
  ef_construction: uint16
  nodes: Array<[
    docId:       string,
    layer:       uint8,
    connections: Array<[
      layer_index: uint8,
      neighbor_ids: Array<string>
    ]>
  ]>
}
```

### Auto-Promotion

Narsil uses a two-tier approach to vector search:

- **Under ~10,000 vectors:** Brute-force linear scan. Simple, exact,
  deterministic.
- **Above ~10,000 vectors:** HNSW. Built from existing vectors in a
  background task. The search backend switches from brute-force to
  HNSW transparently.

The promotion threshold (10,000) is configurable and should be
validated by benchmarks.

---

## Similarity Functions

Three metrics for vector distance/similarity computation. All operate
on `Float32Array` for memory efficiency.

### Cosine Similarity

```text
cosine(a, b) = dot(a, b) / (magnitude(a) * magnitude(b))

where:
  dot(a, b) = SUM(a[i] * b[i]) for i in 0..dimension
  magnitude(v) = sqrt(SUM(v[i]^2)) for i in 0..dimension
```

Range: \[-1, 1\]. Higher is more similar. Default metric.

Pre-compute and store `magnitude(v)` at insertion time to avoid
recomputation during search. If either vector has zero magnitude,
return 0 (no similarity).

### Dot Product

```text
dotProduct(a, b) = SUM(a[i] * b[i]) for i in 0..dimension
```

Range: unbounded. Higher is more similar. Use when vectors are already
normalized to unit length (in that case, dot product equals cosine
similarity).

### Euclidean Distance

```text
euclidean(a, b) = sqrt(SUM((a[i] - b[i])^2) for i in 0..dimension)
```

Range: \[0, infinity). Lower is more similar. For ranking purposes,
the square root can be omitted (squared distance preserves ordering).

---

## Haversine Distance

Computes the great-circle distance between two points on a sphere.
Uses the mean Earth radius (6,371,008.8 meters). Fast, accurate for
short distances.

### Haversine Formula

```text
a = sin^2((lat2 - lat1) / 2)
  + cos(lat1) * cos(lat2) * sin^2((lon2 - lon1) / 2)
c = 2 * atan2(sqrt(a), sqrt(1 - a))
distance = R * c
```

Where:

- `lat1, lon1, lat2, lon2` are in **radians**
  (convert from degrees: `rad = deg * PI / 180`)
- `R = 6,371,008.8` meters (mean Earth radius)
- Result is in **meters**

### Unit Conversion

| Unit | Conversion from meters   |
|------|--------------------------|
| `km` | distance / 1000          |
| `mi` | distance / 1609.344      |
| `m`  | distance (no conversion) |

### Haversine Edge Cases

- **Same point:** distance = 0.
- **Antipodal points:** distance = `PI * R` (half circumference).
- **Latitude out of range:** Implementations should accept \[-90, 90\]
  for latitude and \[-180, 180\] for longitude. Values outside these
  ranges are a schema validation error at insertion time.

---

## Vincenty Distance

Computes the geodesic distance between two points on an oblate spheroid
(WGS-84 ellipsoid). More accurate than Haversine for long distances,
but slower due to iterative computation.

### WGS-84 Parameters

```text
a = 6,378,137.0          (semi-major axis in meters)
f = 1 / 298.257223563    (flattening)
b = a * (1 - f)          (semi-minor axis, ~6,356,752.314 meters)
```

### Vincenty Algorithm (Inverse Problem)

Given two points `(lat1, lon1)` and `(lat2, lon2)` in radians:

```text
U1 = atan((1 - f) * tan(lat1))
U2 = atan((1 - f) * tan(lat2))
L = lon2 - lon1

lambda = L  (initial approximation)

repeat until convergence (|lambda_new - lambda| < 1e-12)
  or max 200 iterations:

  sin_sigma = sqrt(
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
    (if cos2_alpha == 0, set cos_2sigma_m = 0)
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

Result is in **meters**.

### Convergence

If the iterative loop does not converge within 200 iterations (which
happens for nearly antipodal points), fall back to the Haversine
formula.

### When to Use

Haversine is the default distance formula. Vincenty is used when the
`highPrecision` flag is set in a geo radius filter. For distances
under ~100 km, the difference between Haversine and Vincenty is
negligible (< 0.3%). For transcontinental distances, Vincenty can
differ by up to 0.5%.

---

## Point-in-Polygon (Ray Casting)

Determines whether a point lies inside a polygon. Used for geo
polygon filters.

### Ray Casting Algorithm

Cast a horizontal ray from the test point to the right. Count how
many polygon edges the ray crosses. Odd count = inside, even count =
outside.

```text
function isPointInPolygon(lat, lon, polygon):
  inside = false
  j = len(polygon) - 1

  for i in 0..len(polygon):
    if (polygon[i].lon > lon) != (polygon[j].lon > lon):
      slope = (polygon[j].lat - polygon[i].lat)
            / (polygon[j].lon - polygon[i].lon)
      intersectLat = polygon[i].lat
                   + slope * (lon - polygon[i].lon)
      if lat < intersectLat:
        inside = !inside
    j = i

  return inside
```

### Polygon Centroid (Shoelace Formula)

Used internally for optimization (e.g., pre-filtering by distance to
centroid before running the full polygon check).

```text
function centroid(polygon):
  A = 0  (signed area)
  cx = 0
  cy = 0
  n = len(polygon)

  for i in 0..n:
    j = (i + 1) % n
    cross = polygon[i].lat * polygon[j].lon
          - polygon[j].lat * polygon[i].lon
    A += cross
    cx += (polygon[i].lat + polygon[j].lat) * cross
    cy += (polygon[i].lon + polygon[j].lon) * cross

  A = A / 2
  cx = cx / (6 * A)
  cy = cy / (6 * A)

  return { lat: cx, lon: cy }
```

### Polygon Edge Cases

- **Point on edge:** Treated as outside (consistent with the ray
  casting algorithm's boundary behavior).
- **Degenerate polygon (< 3 points):** Return false.
- **Self-intersecting polygon:** Behavior is undefined. Implementations
  may choose to support it using the even-odd rule (same as ray
  casting).

---

## CRC32

CRC32 with the IEEE polynomial, used for data integrity checks in
`.nrsl` envelopes.

### Polynomial

```text
IEEE polynomial: 0xEDB88320 (reflected form)
```

### CRC32 Algorithm

Use a 256-entry lookup table for performance:

```text
function buildCRC32Table():
  table = Array[256]
  for i in 0..256:
    crc = i
    for bit in 0..8:
      if crc & 1:
        crc = (crc >>> 1) ^ 0xEDB88320
      else:
        crc = crc >>> 1
    table[i] = crc
  return table

function crc32(data: bytes):
  table = getCachedTable()
  crc = 0xFFFFFFFF
  for byte in data:
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xFF]
  return crc ^ 0xFFFFFFFF
```

### Test Vectors

| Input             | CRC32 (hex)  |
|-------------------|--------------|
| empty bytes       | `0x00000000` |
| ASCII "123456789" | `0xCBF43926` |

### CRC32 Usage

CRC32 is computed over the raw payload bytes (after compression, if
applicable). The result is stored in header bytes 14-17 when the
checksum flag is set. On read, recompute and compare; a mismatch
indicates corruption and must raise a `PERSISTENCE_CRC_MISMATCH` error.

---

## FNV-1a Hash

A fast, non-cryptographic hash function used for partition routing
(`hash(docId) % partitionCount`).

### FNV-1a Algorithm

```text
function fnv1a(input: string):
  hash = 2166136261          (FNV offset basis, uint32)
  for each byte in UTF-8(input):
    hash = hash XOR byte
    hash = hash * 16777619   (FNV prime, uint32)
    hash = hash & 0xFFFFFFFF (keep 32-bit)
  return hash
```

### FNV-1a Test Vectors

| Input             | FNV-1a (hex)   |
|-------------------|----------------|
| empty string      | `0x811C9DC5`   |
| ASCII "foobar"    | `0xBF9CF968`   |

The empty string returns the FNV offset basis unchanged since no
XOR/multiply iterations execute.

### FNV-1a Properties

- Deterministic: same input always produces the same output.
- Uniform distribution: produces well-distributed values for partition
  routing.
- Not cryptographically secure: used only for hash-based routing, never
  for security.

### Cross-Language Note

The input string must be encoded as UTF-8 bytes before hashing. All
implementations must use the same UTF-8 encoding to ensure identical
hash values across languages.
