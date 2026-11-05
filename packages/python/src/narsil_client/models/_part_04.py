"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias

from pydantic import Field
from typing_extensions import TypeAliasType

from narsil_client._model import OPEN_ENUM, ApiModel
from narsil_client.models._part_01 import AnyDocument, BM25Params
from narsil_client.models._part_02 import CreateIndexEmbedding
from narsil_client.models._part_03 import FieldType, HighlightMatch, ScoreComponents


class Hit(ApiModel):
    """One matching document, with the score that ranked it."""

    id: str
    """The document is stored under this id."""
    score: int | float | None = None
    """This score ranked the hit. Scores compare within one result set, never across searches. A
    sorted query ranks by sort values instead and carries no score unless it sets
    `includeScores`.
    """
    document: AnyDocument
    """This is the stored document."""
    score_components: ScoreComponents | None = Field(default=None, alias="scoreComponents")
    """These are the parts the score was built from, which arrive when the query asked for them."""
    highlights: dict[str, HighlightMatch] | None = None
    """These highlighted snippets are keyed by field, and arrive when the query asked for
    highlighting.
    """


class PartitionConfig(ApiModel):
    """How many partitions an index opens with, and how many documents it accepts. An index opens
    with `maxPartitions` partitions and keeps that count until Narsil.rebalance changes it,
    because the engine adds no partition on its own. Set `watermark` to learn through the
    `partitionWatermark` event when an index fills its capacity.
    """

    max_docs_per_partition: int | float | None = Field(default=None, alias="maxDocsPerPartition")
    """The index accepts this many documents for each of its partitions, so its capacity is this
    number multiplied by its partition count. A write beyond that capacity raises
    `PARTITION_CAPACITY_EXCEEDED`. Leave the field unset to accept any number.
    """
    max_partitions: int | float | None = Field(default=None, alias="maxPartitions")
    """The index opens with this many partitions, 1 by default, and no rebalance may take it
    higher.
    """
    watermark: int | float | None = None
    """The engine emits `partitionWatermark` once the index fills this share of its capacity, above
    0 and at most 1.
    """


SchemaDefinition = TypeAliasType("SchemaDefinition", "dict[str, FieldType | SchemaDefinition]")
"""The field layout of an index, written as a plain object. Each key names a field and each value is
either its FieldType or a nested schema, which is how you describe an object inside a document.
Nesting goes four levels deep.
"""


class OneWaySynonymRule(ApiModel):
    """A one-way rule adds each word in `synonyms` to a search for `word`, while a search for one
    of those synonyms gains nothing from the rule.
    """

    word: str
    """A search for this word also matches the words in `synonyms`."""
    synonyms: list[str]
    """The rule holds from 1 to 99 synonyms, and each one must analyse to exactly one token."""


class TwoWaySynonymRule(ApiModel):
    """A two-way rule makes every word in `words` a synonym of every other word in the rule, so a
    search for any one of them also matches documents that hold the others.
    """

    words: list[str]
    """The rule holds from 2 to 100 words, and each word must analyse to exactly one token."""


SynonymRule: TypeAlias = TwoWaySynonymRule | OneWaySynonymRule
"""One rule of a synonym set, which IndexConfig.synonyms and SynonymOperations.updateSynonyms take as a
list. The engine analyses every word with the language, the tokeniser, and the stop words of the
index, so a rule that says `jackets` also matches `jacket` wherever the index stems the two alike. A
set can hold up to 100,000 rules, 500,000 words, and 4,194,304 bytes of words in UTF-8.
"""


class VectorIndexConfigHnswConfig(ApiModel):
    """These settings shape the graph: neighbours per node, build-time exploration, and the metric
    that ranks results.
    """

    m: int | float | None = None
    """The graph keeps this many neighbours per node."""
    ef_construction: int | float | None = Field(default=None, alias="efConstruction")
    """The engine explores this many candidates as it builds the graph."""
    metric: Annotated[Literal["cosine", "dotProduct", "euclidean"], OPEN_ENUM] | None = None
    """This metric ranks the results."""


class VectorIndexConfig(ApiModel):
    """Controls when a vector field moves from a brute-force scan to an HNSW graph, and how that
    graph is built. A small field answers faster from a brute-force scan, so the engine builds a
    graph only once the field holds enough vectors to earn one. Leave every field unset to
    accept the engine's own values.
    """

    threshold: int | float | None = None
    """The engine promotes the field to an HNSW graph once it holds this many vectors."""
    filter_threshold: int | float | None = Field(default=None, alias="filterThreshold")
    """A selectivity ratio between 0 and 1, defaulting to 0.03. A filtered search whose filter
    matches a smaller share of the graph's vectors scans just the matches, and one matching a
    larger share searches the graph. The engine clamps any value outside that range to it.
    """
    hnsw_config: VectorIndexConfigHnswConfig | None = Field(default=None, alias="hnswConfig")
    """These settings shape the graph: neighbours per node, build-time exploration, and the metric
    that ranks results.
    """
    quantization: Annotated[Literal["osq8", "osq4", "osq2", "osq1", "none"], OPEN_ENUM] | None = None
    """The engine codes the promoted vectors in this mode. When this is unset, it picks the mode by
    the field's dimension. Set `none` to rank by the vectors alone.
    """
    storage: Annotated[Literal["memory", "disk"], OPEN_ENUM] | None = None
    """The engine keeps the field's full-precision vectors here. When this is unset, it picks
    `disk` under filesystem durability and `memory` on every other engine.
    """


class HttpIndexBody(ApiModel):
    """The settings of a new index as `POST /indexes` reads them, which is HttpIndexConfig with
    each field type spelled out.
    """

    bm25: BM25Params | None = None
    """These parameters tune BM25 for this index and for each of its text fields."""
    language: str | None = None
    """The server tokenises and stems text fields with the language module registered under this
    name.
    """
    default_scoring: Annotated[Literal["local", "dfs", "broadcast"], OPEN_ENUM] | None = Field(
        default=None, alias="defaultScoring"
    )
    """A query scores this way unless it asks for another mode."""
    tokenizer: str | None = None
    """This is the name of a tokeniser registered on the server, which then splits text in place of
    the language's own rules.
    """
    stop_words: str | list[str] | None = Field(default=None, alias="stopWords")
    """This name of a stop word set registered on the server, or this list, replaces the language's
    stop words.
    """
    track_positions: bool | None = Field(default=None, alias="trackPositions")
    """Setting this records term positions in each posting, which the `.nrsl` format carries for
    readers that match phrases. Highlighting works without it.
    """
    text_storage: Annotated[Literal["memory", "disk"], OPEN_ENUM] | None = Field(default=None, alias="textStorage")
    """Setting this to `disk` lets the index answer from segment files that the server reads by
    position, which needs filesystem durability. The default is `memory`.
    """
    surface_forms: bool | None = Field(default=None, alias="surfaceForms")
    """Setting this to false returns index stems from suggestions and prefix expansion, instead of
    the words users typed.
    """
    strict: bool | None = None
    """Setting this rejects a document carrying a field the schema does not declare."""
    embedding: CreateIndexEmbedding | None = None
    """This names a server-registered embedding adapter and the fields it embeds."""
    required: list[str] | None = None
    """The server rejects a document that omits any of these fields."""
    pattern_value_limit: int | float | None = Field(default=None, alias="patternValueLimit")
    """The server returns a `DOC_VALIDATION_FAILED` error for a document whose value in a
    `verbatim` field, or in a field whose type includes `pattern`, is longer than this many code
    points. Set a whole number from 1 to 65,536, or leave this unset for a limit of 8,192.
    """
    synonyms: list[SynonymRule] | None = None
    """A search for a word in one of these rules also matches its synonyms, and the server refuses
    a set beyond 100,000 rules, 500,000 words, or 4,194,304 bytes of words in UTF-8 with
    `CONFIG_INVALID`.
    """
    schema_: SchemaDefinition = Field(alias="schema")
    """This layout gives each value as either a field type or a nested schema."""
    partitions: PartitionConfig | None = None
    """These settings control how the index splits documents across partitions as it grows."""
    vector_promotion: VectorIndexConfig | None = Field(default=None, alias="vectorPromotion")
    """These settings control when vector fields move to an HNSW graph, and how that graph is
    built.
    """


class HttpCreateIndexBody(ApiModel):
    """The body of `POST /indexes`, which is CreateIndexRequest with the settings of HttpIndexBody."""

    name: str
    """The server creates the index under this name."""
    config: HttpIndexBody
    """This carries the schema and settings, in the subset JSON can express."""


class HttpGroupResult(ApiModel):
    """One group of hits as the server sends it, which is GroupResult with no reducer output,
    because the server refuses a query with a reducer.
    """

    hits: list[Hit]
    """These hits fall in the group, cut to the query's `maxPerGroup`."""
    values: dict[str, Any]
    """Each grouping field holds this value for the group, keyed by field."""


class HttpQueryParamsPinnedItem(ApiModel):
    """The shape of one item of the `pinned` field of `HttpQueryParams`."""

    doc_id: str = Field(alias="docId")
    """The engine places the document with this id."""
    position: int | float
    """The document takes this place in the results, counting from zero."""


class HttpQueryParamsDocumentObject(ApiModel):
    """The shape of one form of the `document` field of `HttpQueryParams`."""

    include: list[str] | None = None
    """Names the fields to keep, so every field left out of this list is dropped."""
    exclude: list[str] | None = None
    """Names the fields to drop, so every other field is kept."""


class HttpQueryParamsGroup(ApiModel):
    """These settings collapse the hits into groups by field value."""

    fields: list[str]
    """The values of these fields define a group, and several fields group by their combination."""
    limit: int | float | None = None
    """The engine returns this many groups, best first, and every group where you leave this out."""
    max_per_group: int | float | None = Field(default=None, alias="maxPerGroup")
    """The engine returns this many hits from each group, best first, and one hit where you leave
    this out.
    """


class HybridConfig(ApiModel):
    """How a hybrid query merges its keyword ranking with its vector ranking. `rrf` combines the
    two by rank alone, which needs no tuning and handles scores that live on different scales.
    `linear` blends the scores directly, which gives you control once you know what each side's
    scores look like.
    """

    strategy: Annotated[Literal["rrf", "linear"], OPEN_ENUM] | None = None
    """The engine merges the rankings this way, and by rank fusion by default. It throws
    `CONFIG_INVALID` for any other value.
    """
    k: int | float | None = None
    """The engine uses this rank-fusion constant under `rrf` alone, where a larger value reduces
    the lead of the top ranks. Set a whole number of at least 1, or leave it out for 60. The
    engine throws `CONFIG_INVALID` for any other value.
    """
    alpha: int | float | None = None
    """The engine uses this weight of the vector score, from 0 to 1, under `linear` alone, and 0.5
    where you leave it out. It throws `CONFIG_INVALID` for a value outside that range.
    """
    depth: int | float | None = None
    """Set a depth to get the same fused order on every page of one query, and a cursor that
    resumes it. The engine then fetches this many results from the keyword search and from the
    vector search, fuses them, and pages through the top `depth` of the fused list. The last
    page stops at this depth, so it can hold fewer hits than the limit. Set a whole number from
    1 to 10,000. The engine throws `CONFIG_INVALID` for any other value, and
    `SEARCH_RESULT_WINDOW_EXCEEDED` for a page that starts at this depth or beyond. Where you
    leave the depth out, each search fetches only enough results to fill the page, so the fused
    order can change from one page to the next, and a cluster refuses a cursor with
    `SEARCH_INVALID_CURSOR`.
    """


class RerankConfig(ApiModel):
    """How a query reorders its top hits with a rerank adapter. The engine ranks the query as it
    would without this setting, passes the top `window` hits to the adapter, and orders them by
    the adapter's scores. The hits past the window follow in their first ranking, with their
    scores scaled below the lowest reranked score, so every page of one query comes from the
    same order.
    """

    adapter: str
    """The engine scores the hits with the rerank adapter registered under this key. It throws
    `RERANK_CONFIG_INVALID` for a key that it has not registered.
    """
    fields: list[str]
    """The engine sends the adapter the values of these text fields, in this order and joined with
    newlines, as the text of each hit. Each member of a list field takes a line of its own. The
    engine throws `RERANK_CONFIG_INVALID` for an empty list, for a field that the schema does
    not declare as text, and for a field that the list gives twice.
    """
    query: str | None = None
    """The adapter compares each hit with this text. Where you leave it out, the engine sends the
    query's `term`, or else its `vector.text`, and it throws `RERANK_CONFIG_INVALID` where the
    query carries neither.
    """
    window: int | float | None = None
    """The engine reranks this many of the top hits, from 1 to the engine's `maxRerankWindow`.
    Where you leave the window out, the engine reranks the smallest of 100 and
    `maxRerankWindow`, and no more than the `hybrid.depth` of a hybrid query that sets one. A
    hybrid query that sets `hybrid.depth` reranks its fused list at that depth, so the engine
    throws `RERANK_CONFIG_INVALID` when you set a window above that depth.
    """
