"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from narsil_client._operations.cluster import ClusterOperations
from narsil_client._operations.documents import DocumentsOperations
from narsil_client._operations.documents_2 import DocumentsOperations2
from narsil_client._operations.indexes import IndexesOperations
from narsil_client._operations.maintenance import MaintenanceOperations
from narsil_client._operations.maintenance_2 import MaintenanceOperations2
from narsil_client._operations.search import SearchOperations
from narsil_client._operations.server import ServerOperations
from narsil_client._operations.tasks import TasksOperations


class Operations(
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
