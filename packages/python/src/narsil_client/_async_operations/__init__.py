"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from narsil_client._async_operations.cluster import ClusterOperations
from narsil_client._async_operations.documents import DocumentsOperations
from narsil_client._async_operations.documents_2 import DocumentsOperations2
from narsil_client._async_operations.indexes import IndexesOperations
from narsil_client._async_operations.maintenance import MaintenanceOperations
from narsil_client._async_operations.maintenance_2 import MaintenanceOperations2
from narsil_client._async_operations.search import SearchOperations
from narsil_client._async_operations.server import ServerOperations
from narsil_client._async_operations.tasks import TasksOperations


class AsyncOperations(
    ServerOperations,
    ClusterOperations,
    TasksOperations,
    IndexesOperations,
    DocumentsOperations,
    DocumentsOperations2,
    SearchOperations,
    MaintenanceOperations,
    MaintenanceOperations2,
):
    """These methods call every route of a Narsil server, one method for each route."""
