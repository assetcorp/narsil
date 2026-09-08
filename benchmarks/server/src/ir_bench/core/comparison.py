from __future__ import annotations

from .latency_report import client_summary, disclosure, server_summary
from .types import EQUAL_PRECISION, KEYWORD, TRACKS


def build_comparison(reports: list[dict], profile: str = EQUAL_PRECISION) -> dict:
    engines = [
        {
            "name": r["engine"]["name"],
            "version": r["engine"].get("version"),
            "build_identity": r["engine"].get("build_identity"),
            "image_digest": r["engine"].get("image_digest"),
            "tracks": r["engine"].get("tracks", []),
            "keyword_setup": r["engine"].get("keyword_setup"),
            "server_setup": r["engine"].get("server_setup"),
        }
        for r in reports
    ]

    buckets: dict[tuple[str, str], list[dict]] = {}
    track_datasets: dict[str, list[str]] = {track: [] for track in TRACKS}
    dataset_identities: dict[str, dict] = {}
    for report in reports:
        engine_name = report["engine"]["name"]
        for result in report["datasets"]:
            track = result.get("track", KEYWORD)
            dataset_id = result["dataset_id"]
            identity = result.get("dataset_identity")
            if identity and dataset_id not in dataset_identities:
                dataset_identities[dataset_id] = identity
            key = (track, dataset_id)
            if key not in buckets:
                buckets[key] = []
                if dataset_id not in track_datasets.setdefault(track, []):
                    track_datasets[track].append(dataset_id)
            latency = result.get("latency", {})
            buckets[key].append(
                {
                    "engine": engine_name,
                    "metrics": result.get("metrics"),
                    "judged_queries": result.get("judged_queries"),
                    "vector_model": result.get("vector_model"),
                    "vector_dims": result.get("vector_dims"),
                    "latency": latency,
                    "latency_server": server_summary(latency) or {},
                    "latency_client": client_summary(latency),
                    "server_time_resolution": latency.get("server_time_resolution"),
                    "server_time_disclosure": disclosure(latency),
                    "throughput": result.get("throughput"),
                    "operational": result.get("operational", {}),
                    "operating_point": result.get("operating_point"),
                    "setup": result.get("setup"),
                    "server_setup": result.get("server_setup"),
                    "quantization": result.get("quantization"),
                }
            )

    tracks_out = []
    for track in TRACKS:
        datasets = [
            {"dataset_id": dataset_id, "rows": buckets[(track, dataset_id)]}
            for dataset_id in track_datasets.get(track, [])
        ]
        if datasets:
            tracks_out.append({"track": track, "datasets": datasets})

    return {
        "environment": reports[0]["environment"] if reports else {},
        "config": reports[0]["config"] if reports else {},
        "profile": profile,
        "engines": engines,
        "dataset_identities": dataset_identities,
        "tracks": tracks_out,
    }
