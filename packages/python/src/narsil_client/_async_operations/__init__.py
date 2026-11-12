"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from narsil_client._async_operations.changes import ChangesOperations
from narsil_client._async_operations.cluster import ClusterOperations
from narsil_client._async_operations.documents import DocumentsOperations
from narsil_client._async_operations.indexes import IndexesOperations
from narsil_client._async_operations.maintenance import MaintenanceOperations
from narsil_client._async_operations.query_suggestions import QuerySuggestionsOperations
from narsil_client._async_operations.search import SearchOperations
from narsil_client._async_operations.server import ServerOperations
from narsil_client._async_operations.sync import SyncOperations
from narsil_client._async_operations.tasks import TasksOperations


class AsyncOperations(
    ServerOperations,
    ClusterOperations,
    TasksOperations,
    IndexesOperations,
    DocumentsOperations,
    SearchOperations,
    MaintenanceOperations,
    SyncOperations,
    ChangesOperations,
    QuerySuggestionsOperations,
):
    """These methods call every route of a Narsil server, one method for each route."""
