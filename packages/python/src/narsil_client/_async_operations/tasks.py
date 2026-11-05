"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from narsil_client._async_transport import AsyncOperationsBase
from narsil_client._exchange import Exchange, path_segment, query_list, query_value
from narsil_client.models import TaskListPage, TaskRecord, TaskStatus, TaskType


class TasksOperations(AsyncOperationsBase):
    """These methods call the Tasks routes of a Narsil server."""

    async def list_tasks(
        self,
        *,
        index_name: str | None = None,
        type: list[TaskType] | None = None,
        status: list[TaskStatus] | None = None,
        from_: int | float | None = None,
        limit: int | float | None = None,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskListPage:
        """List task records, newest first.

        `GET /tasks`

        Args:
            index_name: Keeps the tasks running against this index.
            type: Keeps the tasks of these types.
            status: Keeps the tasks at these statuses.
            from_: Skips this many records, and starts at the newest by default.
            limit: The page carries this many records, and 20 by default.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            TaskListPage,
            await self._transport.json(
                Exchange(
                    method="GET",
                    path="/tasks",
                    query={
                        "indexName": query_value(index_name),
                        "type": query_list(type),
                        "status": query_list(status),
                        "from": query_value(from_),
                        "limit": query_value(limit),
                    },
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: TaskListPage},
            ),
        )

    async def get_task(
        self,
        id: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Read one task record.

        `GET /tasks/{id}`

        Args:
            id: The id of the task.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            TaskRecord,
            await self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/tasks/{path_segment(id)}",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: TaskRecord},
            ),
        )

    async def cancel_task(
        self,
        id: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Ask a running task to stop.

        `POST /tasks/{id}/_cancel`

        Args:
            id: The id of the task.
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
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/tasks/{path_segment(id)}/_cancel",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )
