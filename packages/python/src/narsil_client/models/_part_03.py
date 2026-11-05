"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field

from narsil_client._model import OPEN_ENUM, ApiModel
from narsil_client.models._part_01 import ArrayFilter, ComparisonFilter
from narsil_client.models._part_02 import GeoPolygonFilter


class GeoRadiusFilterRadius(ApiModel):
    """The engine tests the field against this circle."""

    lat: int | float
    """The centre has this latitude, in degrees from -90 to 90. For any other value, the engine
    throws `SEARCH_INVALID_FILTER`.
    """
    lon: int | float
    """The centre has this longitude, in degrees from -180 to 180. For any other value, the engine
    throws `SEARCH_INVALID_FILTER`.
    """
    distance: int | float
    """The circle has this radius, measured in `unit`."""
    unit: Annotated[Literal["km", "mi", "m"], OPEN_ENUM]
    """The engine measures `distance` in kilometres under `'km'`, in miles under `'mi'`, and in
    metres under `'m'`. For any other unit, it throws `SEARCH_INVALID_FILTER`.
    """
    inside: bool | None = None
    """The engine matches the points inside the circle while this is true, which is the default,
    and the points outside it while this is false.
    """
    high_precision: bool | None = Field(default=None, alias="highPrecision")
    """The engine measures each distance with the Haversine formula on a sphere by default, and
    with Vincenty's formula on the WGS-84 ellipsoid while this is true. Vincenty's formula
    iterates, so the engine takes longer to compute each distance. The two formulas differ by
    less than 0.3% under about 100 km, while across a continent they can differ by up to 0.5%.
    """


class GeoRadiusFilter(ApiModel):
    """Matches a `geopoint` field against a circle drawn on the earth."""

    radius: GeoRadiusFilterRadius
    """The engine tests the field against this circle."""


class PresenceFilter(ApiModel):
    """Tests whether a field carries a value at all, without looking at what it holds."""

    exists: bool | None = None
    """This matches a document where the field holds a value other than null."""
    not_exists: bool | None = Field(default=None, alias="notExists")
    """This matches a document where the field is absent or null."""
    is_empty: bool | None = Field(default=None, alias="isEmpty")
    """This matches a document where the field is absent, null, an empty string, or an empty list.
    """
    is_not_empty: bool | None = Field(default=None, alias="isNotEmpty")
    """This matches a document where the field holds a value other than an empty string or an empty
    list.
    """


class StringFilter(ApiModel):
    """The engine tests a text field against this filter for equality, for a text range, or with
    the set, prefix, and pattern tests. On a `string[]`, `verbatim[]`, or `enum[]` field, the
    engine tests each element of the list on its own. A document passes `eq`, `in`,
    `startsWith`, `endsWith`, `contains`, `wildcard`, or `regex` when one element passes the
    test. However, a document passes `ne` or `nin` only when every element differs from the
    values. The engine applies the range tests `gt`, `gte`, `lt`, `lte`, and `between` to a
    single `string` or `verbatim` field whose type includes `sortable`. It throws
    `SEARCH_INVALID_FILTER` for a text range on any other field. It orders the values as a sort
    on the field does, so it compares their case folds first and compares their raw code points
    only where the folds are equal. A pattern field is a `verbatim` or `verbatim[]` field, or a
    `string` or `string[]` field whose type includes `pattern`. On a pattern field, the engine
    answers `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `contains`, `wildcard`, and
    `regex` from the field's pattern index, and `caseFold` applies to each of those tests. The
    engine compares the code points of each value as they are stored, with no Unicode
    normalisation. On an `enum` or `enum[]` field, the engine answers `eq`, `ne`, `in`, `nin`,
    `startsWith`, and `endsWith` from the field's index of values. A `string` or `string[]`
    field whose type leaves out `pattern` keeps no index of whole values, so the engine throws
    `SEARCH_INVALID_FILTER` for those six tests, and for `matchesAny` and `containsAll`, on such
    a field. The engine also throws `SEARCH_INVALID_FILTER` in these cases: - The filter sets
    `contains`, `wildcard`, `regex`, or `caseFold` on a field that is not a pattern field. - The
    text or the pattern of a test on a pattern field holds more than 1,024 code points. - A
    literal test under `caseFold` has a text whose case fold holds more than 2,048 code points.
    - A `wildcard` or `regex` pattern breaks its syntax or one of its limits.
    """

    eq: bool | str | int | float | None = None
    """This matches a field equal to the value, or a list field where one element equals it."""
    ne: bool | str | int | float | None = None
    """This matches a document that holds the field with a value other than this one, or a list
    field where every element differs from it, which an empty list does.
    """
    gt: str | None = None
    """This matches a value that comes after the text in sort order."""
    lt: str | None = None
    """This matches a value that comes before the text in sort order."""
    gte: str | None = None
    """This matches a value equal to the text or after it in sort order."""
    lte: str | None = None
    """This matches a value equal to the text or before it in sort order."""
    between: tuple[str, str] | None = None
    """This matches a value inside the inclusive range in sort order, given as `[low, high]`."""
    in_: list[str] | None = Field(default=None, alias="in")
    """This matches a field equal to any value in the list, which holds at most 65,536 values."""
    nin: list[str] | None = None
    """This matches a field that differs from every value in the list, which holds at most 65,536
    values.
    """
    starts_with: str | None = Field(default=None, alias="startsWith")
    """This matches a field starting with the text."""
    ends_with: str | None = Field(default=None, alias="endsWith")
    """This matches a field ending with the text."""
    contains: str | None = None
    """This matches a pattern field whose value holds the text anywhere in it."""
    wildcard: str | None = None
    """This matches a pattern field when the whole value matches the wildcard pattern. For example,
    `INV-*-2024` matches `INV-0042-2024`. In the pattern, `*` matches any sequence of code
    points, including an empty one, and `?` matches exactly one code point. Write `\\` before a
    code point to match that code point itself, so `\\*` matches an asterisk. The engine throws
    `SEARCH_INVALID_FILTER` for a pattern that ends in a `\\` with no code point after it. It
    throws the same error for a pattern with more than 2,048 positions. Each `*`, each `?`, and
    each other code point counts as one position, except that under `caseFold` a code point
    counts once for each code point of its case fold.
    """
    regex: str | None = None
    """This matches a pattern field when some part of the value matches the regular expression. `^`
    and `$` match only at the start and at the end of the whole value. The engine accepts
    literal code points, `.`, `\\d`, `\\w`, and `\\s`, sets such as `[a-z]` and `[^0-9]`,
    groups, and `|`. It also accepts the repeats `*`, `+`, `?`, `{n}`, `{n,}`, and `{n,m}`, the
    anchors `^` and `$`, the word edge `\\b`, and number ranges such as `<1-65535>`. A number
    range matches the digits of any whole number from its low end to its high end. Write `\\`
    before an ASCII punctuation mark to match the mark itself. The `.` matches any code point,
    including a line break. The matcher never backtracks, so it checks a value in at most as
    many steps as the value's code points multiplied by the pattern's positions. The engine
    throws `SEARCH_INVALID_FILTER` for any construct outside that syntax, such as a
    back-reference, a lookaround, a lazy repeat, or an inline flag. It throws the same error
    when the groups of a pattern nest more than 32 deep, when a count is above 2,048, and when a
    pattern holds more than 2,048 positions. When the operator of an HTTP server sets its
    `allowRegex` option to false, the server refuses every `regex` test.
    """
    case_fold: bool | None = Field(default=None, alias="caseFold")
    """When this is true, the engine compares the case fold of each value of a pattern field with
    the case fold of the text, so a test for `error` matches `ERROR`. It applies to `eq`, `ne`,
    `in`, `nin`, `startsWith`, `endsWith`, `contains`, `wildcard`, and `regex`. Under
    `caseFold`, a set that does not open with `^` can also match a sequence of code points. When
    a member that the set holds on its own folds to several code points, the set matches that
    whole fold, so `[ß]` matches `ss`.
    """
    tolerance: Annotated[Literal["auto"], OPEN_ENUM] | Literal[0, 2, 1] | None = None
    """This lets the `eq` test of a pattern field match a value within this many edits of the text,
    so a test for `INV-2O24` with a tolerance of 1 matches `INV-2024`. An edit inserts, deletes,
    or replaces one code point, so a swap of two neighbouring code points counts as two edits.
    With `caseFold`, the engine counts the edits between the case folds of the value and the
    text. The tolerance applies to `eq` alone, so the other tests of the field still compare
    exactly. The engine takes its candidates from the pattern index, so the case fold of the
    text has to hold enough distinct runs of three code points. For a tolerance of `k`, the
    engine needs `k × (2 + f) + 1` runs, where `f` is the number of code points in the longest
    case fold among the text's code points, which is 1 for most text. A tolerance of 1 on
    `INV-2O24` therefore needs 4 of its 6 runs, while a tolerance of 2 needs 7. Under `'auto'`,
    the engine uses 2 where the text holds enough runs for 2, otherwise 1 where it holds enough
    for 1, and otherwise 0. The engine throws `SEARCH_INVALID_FILTER` for a tolerance of 1 or 2
    on a text with too few runs, stating how many runs that tolerance needs. It throws the same
    error for any other tolerance, for a tolerance on a field that is not a pattern field, and
    for a tolerance in a filter without an `eq` test. Towards the pattern work cap, it counts
    one unit for each cell that it fills in the table of edit distances between the text and a
    value.
    """


FieldFilter: TypeAlias = (
    ComparisonFilter | StringFilter | ArrayFilter | PresenceFilter | GeoRadiusFilter | GeoPolygonFilter
)
"""The filter one field accepts. Which of these forms applies follows from the field's declared type.
"""


FieldType: TypeAlias = (
    Annotated[
        Literal[
            "string",
            "number",
            "boolean",
            "string:sortable",
            "string:pattern",
            "string:partial",
            "string:pattern:partial",
            "string:partial:pattern",
            "string:sortable:pattern",
            "string:sortable:partial",
            "string:sortable:pattern:partial",
            "string:sortable:partial:pattern",
            "string:partial:sortable",
            "string:pattern:sortable",
            "string:pattern:sortable:partial",
            "string:pattern:partial:sortable",
            "string:partial:sortable:pattern",
            "string:partial:pattern:sortable",
            "string[]",
            "string[]:sortable",
            "string[]:pattern",
            "string[]:partial",
            "string[]:pattern:partial",
            "string[]:partial:pattern",
            "string[]:sortable:pattern",
            "string[]:sortable:partial",
            "string[]:sortable:pattern:partial",
            "string[]:sortable:partial:pattern",
            "string[]:partial:sortable",
            "string[]:pattern:sortable",
            "string[]:pattern:sortable:partial",
            "string[]:pattern:partial:sortable",
            "string[]:partial:sortable:pattern",
            "string[]:partial:pattern:sortable",
            "verbatim",
            "verbatim:sortable",
            "verbatim[]",
            "verbatim[]:sortable",
            "enum",
            "geopoint",
            "number[]",
            "boolean[]",
            "enum[]",
        ],
        OPEN_ENUM,
    ]
    | str
)
"""The engine indexes each field of a schema according to the field's type, which is one of these. The
engine splits a `string` value into words, so it can find the document by any word in the value. It
can filter and sort by a `number`, `boolean`, or `enum` field. A `geopoint` value is a latitude and
longitude pair. A `vector[N]` value is an embedding with N dimensions. For each list form, the
engine indexes every element of the list. The engine stores and compares a `verbatim` value exactly
as written, as one piece of text. Because the engine keeps that value whole, it leaves the field out
of keyword search, although it can test the whole value in a filter. The engine keeps a pattern
index for every `verbatim` field, so it can also test such a field with `contains` and `caseFold`.
Add the TextFieldOption options to a `string` or `string[]` type, or `sortable` alone to a
`verbatim` or `verbatim[]` type, as in `string:sortable:pattern` or `verbatim[]:sortable`. The
engine stores the options in the order `sortable`, `pattern`, `partial`, whatever their order in the
type name. It raises `SCHEMA_INVALID_TYPE` for any other option, such as `number:sortable` or
`verbatim:pattern`, and for an option written twice. To sort by a text field, the engine keeps up to
the first 512 code points of every document's value in memory, against 8 bytes per document for a
number field. For that reason, the engine sorts by a text field only where the field's type includes
`sortable`, while it raises `SEARCH_INVALID_FIELD` for a sort on any other text field.
"""


class FilterExpression(ApiModel):
    """The filter that a query runs, built from per-field tests and the boolean operators that
    combine them. The engine answers every test from an index that it keeps for the field. It
    applies the filter before scoring, so a narrow filter makes a search cheaper. A filter nests
    at most 30 levels deep and holds at most 1,024 tests, counted across every field and nested
    expression. Past either limit, the engine throws `SEARCH_INVALID_FILTER`, while it throws
    `SEARCH_INVALID_FIELD` for a test on a field that the schema leaves out.
    """

    fields: dict[str, FieldFilter] | None = None
    """These per-field tests are keyed by field name, and a document has to satisfy every entry."""
    and_: list[FilterExpression] | None = Field(default=None, alias="and")
    """Every nested expression has to match."""
    or_: list[FilterExpression] | None = Field(default=None, alias="or")
    """At least one nested expression has to match."""
    not_: FilterExpression | None = Field(default=None, alias="not")
    """The nested expression has to fail."""


class HeldCheckpointReport(ApiModel):
    """An index whose checkpoints wait until a failed partition recovers, as Narsil.getMemoryStats
    reports it. The engine holds these checkpoints only for an index with a vector field,
    because each vector file mixes every partition's vectors, so a checkpoint would save the
    failed partition's vectors from memory. The write-ahead log of the index grows until the
    partition recovers or you restore the index from a snapshot.
    """

    index_name: str = Field(alias="indexName")
    """This is the index whose checkpoints wait."""
    partition_ids: list[int | float] = Field(alias="partitionIds")
    """These are the partitions of that index whose copy failed."""
    records_since_checkpoint: int | float = Field(alias="recordsSinceCheckpoint")
    """This many write-ahead log records of the index wait for a checkpoint."""
    document_bytes_since_checkpoint: int | float = Field(alias="documentBytesSinceCheckpoint")
    """The documents in those records hold about this many bytes."""


class HighlightConfig(ApiModel):
    """This configuration names the fields that receive highlighted snippets. It also sets how the
    engine marks those snippets up. The engine analyses the text of each returned field again to
    tag every word that it matched, so it tags the same words whatever the index's
    `trackPositions` setting is. It tags a word whose stem equals a query stem, and a word
    within the query's `tolerance` of a query stem. For a `prefix` query, it tags a word for the
    last query term only when that word completes the term or shares its stem.
    """

    fields: list[str]
    """The engine highlights these fields."""
    pre_tag: str | None = Field(default=None, alias="preTag")
    """The engine writes this before each match, and writes `<mark>` by default."""
    post_tag: str | None = Field(default=None, alias="postTag")
    """The engine writes this after each match, and writes `</mark>` by default."""
    max_snippet_length: int | float | None = Field(default=None, alias="maxSnippetLength")
    """The engine takes this many characters of the field around the densest run of matches, 200 by
    default. It returns a snippet longer than that number, because it then adds the opening and
    closing tags, and an ellipsis at each end where it cuts the field.
    """


class HighlightMatchPositionsItem(ApiModel):
    """The shape of one item of the `positions` field of `HighlightMatch`."""

    start: int | float
    """The match starts at this offset."""
    end: int | float
    """The match ends at this offset."""


class HighlightMatch(ApiModel):
    """A highlighted field, ready to render."""

    snippet: str
    """This is the field's text around the match, wrapped in the query's tags."""
    positions: list[HighlightMatchPositionsItem]
    """Each range gives the start and the end of one match in the original field, so you can render
    the highlight yourself. Where the snippet covers part of the field alone, the engine lists
    only the matches that the snippet displays. Every offset is a character count from the start
    of the original field, whatever the snippet contains.
    """


class ScoreComponents(ApiModel):
    """The numbers BM25 combined into one hit's score, which is what you read when a ranking
    surprises you.
    """

    term_frequencies: dict[str, int | float] = Field(alias="termFrequencies")
    """Each query term appears in one field of this document this many times, under a key of
    `field:term`. A term that appears in two fields therefore has two entries here, while the
    keys of ScoreComponents.idf hold the bare term.
    """
    field_lengths: dict[str, int | float] = Field(alias="fieldLengths")
    """Each field the query searched holds this many tokens, keyed by field."""
    idf: dict[str, int | float]
    """Each query term carries this inverse document frequency, which is what makes a rare term
    count for more.
    """
