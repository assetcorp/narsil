from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from pydantic import BaseModel

from narsil_client._errors import TASK_NOT_FOUND, ClientErrorCodes, NarsilError, invalid_response
from narsil_client._exchange import plain
from narsil_client.models import ImportResult, TaskRecord

DEFAULT_TASK_POLL_INTERVAL_MS: Final = 250
TERMINAL_STATUSES: Final = frozenset({"succeeded", "failed", "cancelled"})

ASYNC_IMPORT_CAPABILITY: Final = "documents.import.async"
TASK_CANCEL_CAPABILITY: Final = "tasks.cancel"
TASK_FILTER_CAPABILITY: Final = "tasks.filter"
REBUILD_ANALYSIS_CAPABILITY: Final = "indexes.rebuildAnalysis"
CHANGE_ANALYSIS_CAPABILITY: Final = "indexes.changeAnalysis"
INDEX_LIFECYCLE_CAPABILITY: Final = "indexes.lifecycle"
DOCUMENT_EXPORT_CAPABILITY: Final = "indexes.documentExport"
SYNONYMS_CAPABILITY: Final = "indexes.synonyms"
BM25_TUNING_CAPABILITY: Final = "indexes.bm25"


def is_terminal(record: TaskRecord) -> bool:
    return record.status in TERMINAL_STATUSES


def progress_key(record: TaskRecord) -> str:
    progress = record.progress
    if progress is None:
        return str(record.status)
    return f"{record.status}:{progress.bytes_processed}:{progress.indexed}:{progress.failed}"


def poll_settings(poll_interval_ms: int, wait_timeout_ms: int) -> tuple[float, float]:
    for name, value in (("poll_interval_ms", poll_interval_ms), ("wait_timeout_ms", wait_timeout_ms)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise NarsilError("CONFIG_INVALID", f'"{name}" must be a whole number of milliseconds, 0 or more')
    return poll_interval_ms / 1000, wait_timeout_ms / 1000


def task_gone(task_id: str) -> NarsilError:
    return NarsilError(
        TASK_NOT_FOUND,
        f'The server no longer holds task "{task_id}", so its outcome is unknown',
        {"taskId": task_id},
    )


def task_still_running(task_id: str, wait_timeout_ms: int, record: TaskRecord) -> NarsilError:
    return NarsilError(
        ClientErrorCodes.CLIENT_TASK_TIMEOUT,
        f'Task "{task_id}" was still {record.status} after {wait_timeout_ms} ms, and it keeps running',
        {"taskId": task_id, "wait_timeout_ms": wait_timeout_ms, "status": record.status},
    )


def batch_body(action: str, key: str, values: Iterable[Any], options: BaseModel | Mapping[str, Any] | None) -> Any:
    body: dict[str, Any] = {"action": action, key: [plain(value) for value in values]}
    if options is not None:
        body["options"] = plain(options)
    return body


def expect_import_result(answer: ImportResult | TaskRecord, path: str) -> ImportResult:
    if isinstance(answer, ImportResult):
        return answer
    raise invalid_response(f"The server answered {path} with a task where it should have finished the load", {})


def expect_task(answer: ImportResult | TaskRecord, path: str) -> TaskRecord:
    if isinstance(answer, TaskRecord):
        return answer
    raise invalid_response(f"The server answered {path} with a finished load where it should have started a task", {})
