from __future__ import annotations

from sources import INPROCESS_SUITE_DIR, SERVER_SUITE_DIR

CHART_DIRNAME = "charts"


def server_chart_dir(run_id: str) -> str:
    return f"{SERVER_SUITE_DIR}/results/runs/{run_id}/{CHART_DIRNAME}"


def inprocess_chart_dir(run_id: str) -> str:
    return f"{INPROCESS_SUITE_DIR}/results/runs/{run_id}/{CHART_DIRNAME}"


def _dataset_slug(dataset_id: str) -> str:
    return dataset_id.split("/")[1] if "/" in dataset_id else dataset_id


def bars_chart(directory: str, profile: str, track: str, dataset_id: str) -> str:
    return f"{directory}/{profile}-{track}-{_dataset_slug(dataset_id)}-bars.svg"


def sweep_chart(directory: str, profile: str, track: str, dataset_id: str) -> str:
    return f"{directory}/{profile}-{track}-{_dataset_slug(dataset_id)}-sweep.svg"


def tail_chart(directory: str, profile: str, track: str) -> str:
    return f"{directory}/{profile}-{track}-latency-profile.svg"


def recall_chart(directory: str, dataset_id: str) -> str:
    return f"{directory}/vector-{_dataset_slug(dataset_id)}-throughput-against-recall.svg"


def embedded_scale_chart(directory: str) -> str:
    return f"{directory}/embedded-scale.svg"


def figure(path: str, alt: str) -> str:
    return f'<img src="{path}" alt="{alt}" width="820">'
