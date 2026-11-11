"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._exchange import Exchange, json_body, path_segment, query_value
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import (
    ManualQuerySuggestion,
    ManualSuggestionResponse,
    OkResponse,
    QueryBansBody,
    QuerySuggestionsPreview,
    QuerySuggestionsSetting,
    QuerySuggestionsStatus,
    RecordQueryBody,
    RecordQueryResult,
    RemoveQueryBody,
    RemoveQueryResponse,
    TaskRecord,
)


class QuerySuggestionsOperations(SyncOperationsBase):
    """These methods call the QuerySuggestions routes of a Narsil server."""

    def query_suggestions_status(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> QuerySuggestionsStatus:
        """Report the setting, the last build, and the next build of popular query suggestions.

        `GET /indexes/{name}/query-suggestions`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            QuerySuggestionsStatus,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/query-suggestions",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: QuerySuggestionsStatus},
            ),
        )

    def update_query_suggestions(
        self,
        name: str,
        body: QuerySuggestionsSetting | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Replace the popular query suggestions setting of an index.

        `PUT /indexes/{name}/query-suggestions`

        Args:
            name: The name of the index.
            body: The popular query suggestions setting of one index. Only `enabled` and
                `fields` are required, and each limit that you leave out takes its default.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            self._transport.json(
                Exchange(
                    method="PUT",
                    path=f"/indexes/{path_segment(name)}/query-suggestions",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    def record_query(
        self,
        name: str,
        body: RecordQueryBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> RecordQueryResult:
        """Count a search that a person followed with a click, for the person that the server
        identifies.

        `POST /indexes/{name}/query-suggestions/record`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/query-suggestions/record`. The server
                takes the person and the group from its `identify` function, so the body
                carries the search alone.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            RecordQueryResult,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/query-suggestions/record",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: RecordQueryResult},
            ),
        )

    def build_query_suggestions(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Build the popular query suggestions of an index, as a task.

        `POST /indexes/{name}/query-suggestions/build`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/query-suggestions/build",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    def preview_query_suggestions(
        self,
        name: str,
        *,
        limit: int | float | None = None,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> QuerySuggestionsPreview:
        """List the phrases that the next build would publish.

        `GET /indexes/{name}/query-suggestions/preview`

        Args:
            name: The name of the index.
            limit: The most phrases to list, from 1 to 1,000, and 100 by default.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            QuerySuggestionsPreview,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/query-suggestions/preview",
                    query={"limit": query_value(limit)},
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: QuerySuggestionsPreview},
            ),
        )

    def read_query_bans(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> QueryBansBody:
        """Read the ban list of popular query suggestions.

        `GET /indexes/{name}/query-suggestions/bans`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            QueryBansBody,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/query-suggestions/bans",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: QueryBansBody},
            ),
        )

    def replace_query_bans(
        self,
        name: str,
        body: QueryBansBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> QueryBansBody:
        """Replace the ban list, and remove each newly banned phrase from every suggestions
        index.

        `PUT /indexes/{name}/query-suggestions/bans`

        Args:
            name: The name of the index.
            body: The body of `GET` and of `PUT /indexes/{name}/query-suggestions/bans`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            QueryBansBody,
            self._transport.json(
                Exchange(
                    method="PUT",
                    path=f"/indexes/{path_segment(name)}/query-suggestions/bans",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: QueryBansBody},
            ),
        )

    def remove_query(
        self,
        name: str,
        body: RemoveQueryBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> RemoveQueryResponse:
        """Ban a phrase and remove it from every suggestions index of an index.

        `POST /indexes/{name}/query-suggestions/remove`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/query-suggestions/remove`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            RemoveQueryResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/query-suggestions/remove",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: RemoveQueryResponse},
            ),
        )

    def add_manual_suggestion(
        self,
        name: str,
        body: ManualQuerySuggestion | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ManualSuggestionResponse:
        """Add a suggestion by hand, which a build leaves in place.

        `POST /indexes/{name}/query-suggestions/manual`

        Args:
            name: The name of the index.
            body: A suggestion that a caller adds by hand.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            ManualSuggestionResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/query-suggestions/manual",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ManualSuggestionResponse},
            ),
        )
