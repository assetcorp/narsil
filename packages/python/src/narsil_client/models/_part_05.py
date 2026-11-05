"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from narsil_client._model import OPEN_ENUM, ApiModel
from narsil_client.models._part_01 import BM25Params
from narsil_client.models._part_02 import FacetConfig, FacetResult
from narsil_client.models._part_03 import FilterExpression, HighlightConfig
from narsil_client.models._part_04 import (
    Hit,
    HttpGroupResult,
    HttpQueryParamsDocumentObject,
    HttpQueryParamsGroup,
    HttpQueryParamsPinnedItem,
    HybridConfig,
    RerankConfig,
)


class SortField(ApiModel):
    """One field of a sort, and the direction that field orders by."""

    field: str
    """The field the engine reads, which may name a nested field with dots."""
    direction: Annotated[Literal["asc", "desc"], OPEN_ENUM]
    """Ascending or descending order for this field."""
    mode: Annotated[Literal["min", "max", "avg", "median"], OPEN_ENUM] | None = None
    """Where a document's field holds a list, the engine sorts that document by one value from the
    list: the smallest under `'min'`, the largest under `'max'`, and the mean or the median of
    the list's numbers under `'avg'` or `'median'`. Where you leave this out, the engine uses
    `'min'` for an ascending sort and `'max'` for a descending one. It sorts by a field that
    holds a single value as that value stands, under every mode. It throws
    `SEARCH_INVALID_FIELD` for `'avg'` or `'median'` on a field that the schema declares as
    anything other than `number` or `number[]`.
    """


class VectorQueryConfig(ApiModel):
    """Vector-search inputs passed under `QueryParams.vector`. Supply either a raw `value` array or
    a `text` string for auto-embedding; passing both throws `EMBEDDING_CONFIG_INVALID`. Result
    count is governed by the outer query's `limit`, not by any field on this object.
    """

    field: str
    """Name of the schema field that holds the vector to compare against. Must reference a field
    declared as `vector[N]` in the index schema.
    """
    value: list[int | float] | None = None
    """Raw query vector, given as a number array or a `Float32Array`. Length must match the indexed
    field's dimension or the search rejects the request with `VECTOR_DIMENSION_MISMATCH`.
    """
    text: str | None = None
    """Text to embed at query time using the index or instance embedding adapter. Mutually
    exclusive with `value`; requires a configured adapter.
    """
    similarity: int | float | None = None
    """Score floor applied during ranking. Hits scoring below this value are dropped before `limit`
    is enforced, so the returned hit count can be smaller than `limit` even when more documents
    exist. The floor is interpreted in score space for every metric; for `euclidean`, distance
    is mapped to a similarity score of `1 / (1 + distance)` first. Defaults to no floor.
    """
    metric: Annotated[Literal["cosine", "dotProduct", "euclidean"], OPEN_ENUM] | None = None
    """Similarity metric used for ranking. Defaults to `cosine`. Choose `dotProduct` for raw
    inner-product scoring on already-normalised vectors and `euclidean` for distance-based
    ordering.
    """
    ef_search: int | float | None = Field(default=None, alias="efSearch")
    """The engine keeps this many candidates as it walks the HNSW graph, so a higher value can find
    more of the true neighbours, although each query takes longer. The engine applies it only
    once the field holds a graph. The engine fetches k hits, where k is one more than the number
    of hits up to the end of the page, so k is `limit` plus 1 on a first page. When a query
    leaves `efSearch` unset, the engine keeps the larger of 50 and k plus a margin, where the
    margin is 50 below 768 dimensions, 75 from 768 to 1,023 dimensions, and 0 at 1,024
    dimensions and above. Under a filter, the engine counts only the candidates that pass the
    filter.
    """
    oversample: int | float | None = None
    """The engine re-scores this many times k candidates in a quantized field against the
    full-precision vectors before it returns the best `limit`, where k is one more than the
    number of hits up to the end of the page, so k is `limit` plus 1 on a first page. For a
    value below 1, or for a value that is not a finite number, the engine throws a `NarsilError`
    with code `CONFIG_INVALID`. The engine ignores it on a field whose quantization is `none`.
    When a query leaves it unset, the engine sets the number of candidates that it re-scores
    from k and from the field's dimension. It rounds that number up, and it re-scores at least
    3k candidates under `osq1` and `osq2`, and at least k under `osq4` and `osq8`. Below 768
    dimensions, it re-scores 3.23k + 55.9√k under `osq1` and 2.6k + 22.5√k under `osq2`. From
    768 to 1,023 dimensions, it re-scores 2.2k + 27√k under `osq1` and k + 16√k under `osq2`,
    and under `osq2` it re-scores at least the smaller of k + 75 and k + 18√k. At 1,024
    dimensions and above, it re-scores 3k under both. Under `osq4`, it re-scores 5k below 1,024
    dimensions and 2k from 1,024 dimensions, while under `osq8` it re-scores 2k at every
    dimension. Under a filter, the engine counts only the candidates that pass the filter. On
    vectors spread evenly across every dimension, a one-bit or two-bit code can find fewer than
    95% of the true nearest neighbours at these defaults, so raise `oversample` on a query that
    needs more of them.
    """


class HttpQueryParams(ApiModel):
    """Everything `POST /indexes/{name}/search` accepts, which is QueryParams with a `group` that
    holds no reducer, because a function cannot cross JSON.
    """

    term: str | None = None
    """The engine analyses this text with the index's language module and searches for the terms
    that result. Words inside double quotes form a phrase, which a document has to hold side by
    side and in that order inside one field. The engine throws `SEARCH_INVALID_PHRASE` for a
    phrase of more than 32 words, for more than 32 phrases, and for a phrase on an index with
    `trackPositions` off. It throws `SEARCH_PHRASE_NOT_READY` while an index with a `string[]`
    field waits for a rebuild.
    """
    fields: list[str] | None = None
    """The engine searches the term in these fields, and in every text field in the schema by
    default.
    """
    filters: FilterExpression | None = None
    """The engine scores only the documents that pass this filter. It throws
    `SEARCH_INVALID_FILTER` for an operand of the wrong shape, and for an operator on a field of
    another type, such as `startsWith` on a number field.
    """
    boost: dict[str, int | float] | None = None
    """The engine multiplies the score from each named field by its weight. It throws
    `SEARCH_INVALID_FIELD` for any field other than a text field that the schema declares, and
    `CONFIG_INVALID` for a weight that is not a finite number.
    """
    bm25: BM25Params | None = None
    """These BM25 parameters score this search alone, and they override the index's parameters, so
    a `k1` here also overrides a `k1` that the index sets for a field. The engine validates them
    on every search, and it throws the same errors as IndexConfig.bm25 , except
    `SEARCH_INVALID_FIELD` for a name in `fields` that is not a text field. They change no score
    on a vector search, and on a hybrid search they apply to the keyword ranking alone. A cursor
    pages only a search with the same parameters.
    """
    scoring: Annotated[Literal["local", "dfs", "broadcast"], OPEN_ENUM] | None = None
    """The engine gathers term statistics this way, and follows the index's `defaultScoring` where
    the query sets none.
    """
    min_score: int | float | None = Field(default=None, alias="minScore")
    """The engine drops any hit scoring below this value. It ranks with BM25, which has no fixed
    upper bound, so a floor that suits one index and one query can reject every hit in another.
    """
    term_match: Annotated[Literal["all", "any"], OPEN_ENUM] | int | float | None = Field(
        default=None, alias="termMatch"
    )
    """The engine keeps a document only where the document matches this many query terms, under the
    same `tolerance` and `prefixLength` that the search uses. One term is enough by default.
    """
    tolerance: int | float | None = None
    """The engine matches an indexed term within this edit distance of a query term, so it finds a
    document for a query with a typo. It counts each Unicode code point as one character. Set an
    integer from 0 to 10.
    """
    prefix_length: int | float | None = Field(default=None, alias="prefixLength")
    """The engine applies `tolerance` only to the indexed terms that share this many leading
    characters with the query term, or to the terms that start with the whole query term when
    the query term is shorter. Set an integer from 0 to 1,024; the default is 2.
    """
    prefix: bool | None = None
    """With this set, the engine treats the last query term as an unfinished word, so `secur`
    matches `security`. The engine matches that last term by its stem or by completing it, while
    `tolerance` applies only to the earlier terms, which have to match whole. The engine scores
    completions against a shared document frequency. It also ranks them below whole-word
    matches. The engine ignores this setting where `exact` is true, and the setting is false by
    default.
    """
    partial_words: bool | None = Field(default=None, alias="partialWords")
    """With this set, the engine also matches each query word of three or more characters inside
    the longer words of every field whose type includes `partial`, so a search for `proof`
    matches a document with `waterproof` in such a field. The engine counts each Unicode code
    point as one character. It looks for the query word, before stemming, inside each word
    exactly as that word appears in a document. The engine adds at most 50 such words to a
    query, which it divides as evenly as it can among the query words. Within the share of each
    query word, it adds first the words that the most documents contain. It scores a match
    inside a longer word in proportion to the part of that word that the query word makes up, so
    it scores such a match below a whole-word match at the same frequency in a field of the same
    length. With `highlight`, it tags each whole word that contains a query word in a searched
    `partial` field. The engine applies no `tolerance` to these matches. It ignores this setting
    where `exact` is true or where the searched fields include no `partial` field. Where the
    setting is absent, the engine treats it as false, while it throws `CONFIG_INVALID` for any
    value other than `true` or `false`.
    """
    exact: bool | None = None
    """With this set, the engine matches each query term only against an equal indexed term, so it
    turns off fuzzy matching, prefix completion, partial-word matching, and synonyms. The engine
    still stems the query, because the index stores stemmed terms, so a search for `running`
    matches a document that contains `runs` through the stem that both words share.
    """
    facets: FacetConfig | None = None
    """The engine counts the values of these fields across the matching documents, and each entry
    sets how it cuts and sorts that field's counts. For a field outside the schema, it counts
    the values that the documents store. It throws `SEARCH_INVALID_FIELD` for a `geopoint` or a
    vector field.
    """
    sort: dict[str, Annotated[Literal["asc", "desc"], OPEN_ENUM]] | list[SortField] | None = None
    """The engine sorts the hits by the values of these fields, in place of the relevance ranking.
    Pass an object keyed by field, or a list of fields in the order that the engine compares
    them. The engine sorts by a `number`, `boolean`, or `enum` field, by a text field whose type
    includes `sortable`, or by a list of any of these, which it reduces to one value by the
    entry's `mode`. It throws `SEARCH_INVALID_FIELD` for a sort on a `geopoint` or a vector
    field, because neither type has an order. It throws the same code for a sort on any other
    text field, since the engine keeps up to the first 512 code points of every document's value
    in memory to sort by a text field. The engine orders hybrid results by fusion, so it throws
    `SEARCH_INVALID_MODE` for a sort on a hybrid query. It also throws that code for a direction
    other than `asc` and `desc`.
    """
    limit: int | float | None = None
    """The query returns this many hits, and 10 by default. Pass 0 to read the match count with no
    hits. The engine reads a value below 0 as 0. It falls back to the default for `NaN` and for
    an infinite value, so a page size that you compute from user input never fails the query.
    """
    offset: int | float | None = None
    """The query skips this many hits before returning. A deep offset costs more than a cursor."""
    search_after: str | None = Field(default=None, alias="searchAfter")
    """This cursor comes from a previous result's `cursor`, and pages without an offset's cost."""
    highlight: HighlightConfig | None = None
    """These settings name the fields that come back with highlighted snippets."""
    pinned: list[HttpQueryParamsPinnedItem] | None = None
    """These documents take fixed positions, ahead of the ranking."""
    mode: Annotated[Literal["vector", "hybrid", "fulltext"], OPEN_ENUM] | None = None
    """This picks which engine answers the query. Keyword search runs by default."""
    vector: VectorQueryConfig | None = None
    """These vector-search inputs are required in `vector` and `hybrid` mode."""
    hybrid: HybridConfig | None = None
    """These settings control how the keyword and vector rankings merge in `hybrid` mode."""
    rerank: RerankConfig | None = None
    """These settings reorder the top hits with a rerank adapter, such as a cross-encoder, after
    the keyword, vector, or hybrid ranking. The count matches the count of the same query
    without `rerank`, while the facets and the groups come from the first ranking. The engine
    throws `SEARCH_INVALID_MODE` for a query that also sets a sort, and `RERANK_FAILED` where
    the adapter fails or outlasts the engine's `rerankTimeout`.
    """
    include_scores: bool | None = Field(default=None, alias="includeScores")
    """Setting this returns relevance scores on a sorted query. A query that names a sort ranks by
    sort values alone and computes no scores, so its hits carry none until this restores them. A
    query without a sort ignores this and always carries scores.
    """
    include_score_components: bool | None = Field(default=None, alias="includeScoreComponents")
    """Setting this returns the numbers behind each hit's score, which is what you read when a
    ranking surprises you.
    """
    document: bool | HttpQueryParamsDocumentObject | None = None
    """This chooses how much of each stored document comes back, and the whole document by default.
    """
    group: HttpQueryParamsGroup | None = None
    """These settings collapse the hits into groups by field value."""


class QueryCoverage(ApiModel):
    """How much of an index one search read, which is what you check before you trust a count or a
    ranking. An embedded engine reads every partition it holds, so `queriedPartitions` matches
    `totalPartitions` there and the other two stay zero. A search across a cluster may find a
    node slow or unreachable, which it counts here while still returning the hits the other
    nodes gave it.
    """

    total_partitions: int | float = Field(alias="totalPartitions")
    """The search should have read this many partitions."""
    queried_partitions: int | float = Field(alias="queriedPartitions")
    """The search read this many of them."""
    timed_out_partitions: int | float = Field(alias="timedOutPartitions")
    """The search counts a partition here when the node holding it took longer than the query
    allowed.
    """
    failed_partitions: int | float = Field(alias="failedPartitions")
    """The search counts a partition here when the node holding it returned an error, and when no
    active replica served it.
    """


class HttpQueryResult(ApiModel):
    """The body of `POST /indexes/{name}/search`."""

    facets: dict[str, FacetResult] | None = None
    """These facet counts are keyed by the field each facet was asked for."""
    hits: list[Hit]
    """These documents match, cut to the query's `limit`, best score first or in the query's sort
    order.
    """
    count: int | float
    """This many documents match in total, before the engine applies `limit` and `offset`. For a
    keyword search the engine counts every match. For a vector search it counts every vector
    that passes the query's filter and its `similarity` floor, which is every vector in the
    field where the query sets neither of them. The engine also counts each pinned document that
    the query does not match, since it places that document among the hits.
    """
    count_exact: bool = Field(alias="countExact")
    """`count` holds the exact number of matches where this is true, and a number at or below the
    true total where it is false. Where a query sets a `similarity` floor on a vector field that
    holds a graph, the engine counts only the vectors that it fetches, because it compares the
    query with only a fraction of that field's vectors. For a hybrid query the engine fuses two
    rankings, so the count is exact only where each of those rankings contains every matching
    document. Where you pin a document from outside the hits that the engine fetches, the engine
    reports true only where it holds every match of the query, because only then can it test
    whether the query matches that document.
    """
    elapsed: int | float
    """The engine spent this many milliseconds on the search."""
    cursor: str | None = None
    """This opaque cursor reaches the next page. Pass it back as `searchAfter`."""
    analysis_stale: bool | None = Field(default=None, alias="analysisStale")
    """This turns true when the index's terms came from an older analysis than its language module
    produces now.
    """
    coverage: QueryCoverage
    """The search read this much of the index, which is how you spot a degraded answer."""
    groups: list[HttpGroupResult] | None = None
    """These groups arrive when the query asked for grouping."""
