"""Build the benchmark sentences that the READMEs quote.

Each README holds one `<!-- BENCH:headline START -->` region. The generator fills it
from the same recorded run as BENCHMARKS.md, so every figure in a README comes from
the newest recorded run. The root README links the benchmark page by its path, and the
package README, which npm publishes, links it by its address on GitHub.

The keyword sentences quote the ranking score beside the BM25 engines, because those
engines share Narsil's scoring function. Every speed sentence names the fastest other
engine on its row, whichever engine that is, so the region names no rival by choice.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from chart_data import dataset_rows, peak_qps, tracks
from render import and_join, dataset_name, decimal, engine_name, integer, is_number
from sources import Source, repo_root

KEYWORD_DATASET = "beir/scifact/test"
BM25_ENGINES = ("elasticsearch", "opensearch")
VECTOR_DATASETS_LARGEST_FIRST = (
    "dbpedia-entities-openai-1m",
    "dbpedia-entities-openai-100k",
    "beir/scifact/test",
)
BENCHMARK_CONFIG = "benchmarks/server/config/benchmark.toml"
_QUALITY_METRIC = "ndcg_cut_10"


@dataclass(frozen=True)
class ReadmeTarget:
    path: str
    benchmarks_link: str


README_TARGETS = (
    ReadmeTarget("README.md", "BENCHMARKS.md"),
    ReadmeTarget("packages/ts/README.md", "https://github.com/assetcorp/narsil/blob/main/BENCHMARKS.md"),
)


def reference_ndcg10(dataset_id: str, root: Path | None = None) -> float | None:
    config_path = (root or repo_root()) / BENCHMARK_CONFIG
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    for dataset in config.get("datasets", []):
        if dataset.get("id") == dataset_id and is_number(dataset.get("baseline_ndcg10")):
            return float(dataset["baseline_ndcg10"])
    return None


def _row(rows: list[dict], engine: str) -> dict | None:
    return next((row for row in rows if row.get("engine") == engine), None)


def _ndcg10(row: dict | None) -> float | None:
    value = ((row or {}).get("metrics") or {}).get(_QUALITY_METRIC)
    return float(value) if is_number(value) else None


def _met_its_recall_target(row: dict) -> bool:
    point = row.get("operating_point")
    return not isinstance(point, dict) or point.get("met_target") is not False


def _quality_sentences(rows: list[dict], reference: float | None) -> list[str]:
    narsil = _ndcg10(_row(rows, "narsil"))
    if narsil is None:
        return []
    sentence = f"On BEIR {dataset_name(KEYWORD_DATASET)}, Narsil's BM25 ranking scores {decimal(narsil, 3)} nDCG@10"
    if reference is not None:
        sentence += (
            f", which is within {decimal(abs(narsil - reference), 3)} of the Anserini reference "
            f"of {decimal(reference, 3)}"
        )
    sentences = [f"{sentence}."]
    others = [
        f"{engine_name(name)} scores {decimal(_ndcg10(_row(rows, name)), 3)}"
        for name in BM25_ENGINES
        if _ndcg10(_row(rows, name)) is not None
    ]
    if others:
        sentences.append(f"{and_join(others)} on the same queries.")
    return sentences


def _speed_sentence(rows: list[dict], opening: str, queries: str) -> str | None:
    """One sentence for Narsil's peak on a row, beside the fastest other engine that
    met the row's recall target, whether that engine leads Narsil or follows it."""

    narsil = _row(rows, "narsil")
    narsil_peak = peak_qps(narsil) if narsil is not None else None
    if narsil is None or narsil_peak is None:
        return None
    if not _met_its_recall_target(narsil):
        return f"{opening}, Narsil misses the recall target, so the comparison leaves its speed unranked."
    others = [
        row
        for row in rows
        if row.get("engine") != "narsil" and peak_qps(row) is not None and _met_its_recall_target(row)
    ]
    sentence = f"{opening}, Narsil answers {integer(narsil_peak)} {queries} a second at its peak"
    fastest = max(others, key=lambda row: peak_qps(row) or 0.0, default=None)
    if fastest is None:
        return f"{sentence}."
    fastest_peak = peak_qps(fastest) or 0.0
    name = engine_name(fastest.get("engine") or "")
    if fastest_peak > narsil_peak:
        return f"{sentence}, while {name} leads with {integer(fastest_peak)}."
    return f"{sentence}, and {name} follows with {integer(fastest_peak)}."


def _vector_sentence(comparison: dict) -> str | None:
    target = (comparison.get("config") or {}).get("recall_target")
    for dataset_id in VECTOR_DATASETS_LARGEST_FIRST:
        rows = dataset_rows(comparison, "vector", dataset_id)
        if _row(rows, "narsil") is None:
            continue
        held = f" with every engine held at {decimal(target, 2)} recall" if is_number(target) else ""
        return _speed_sentence(rows, f"On {dataset_name(dataset_id)}{held}", "vector queries")
    return None


def _tally_sentence(comparison: dict) -> str | None:
    compared = 0
    led = 0
    names: list[str] = []
    for entry in tracks(comparison):
        for dataset in entry.get("datasets", []):
            rows = [row for row in dataset.get("rows", []) if peak_qps(row) is not None]
            if len(rows) < 2 or _row(rows, "narsil") is None:
                continue
            compared += 1
            if entry.get("track") not in names:
                names.append(entry.get("track"))
            ranked = [row for row in rows if _met_its_recall_target(row)]
            best = max(ranked, key=lambda row: peak_qps(row) or 0.0, default=None)
            if best is not None and best.get("engine") == "narsil":
                led += 1
    if compared == 0:
        return None
    return (
        f"Narsil has the highest peak throughput in {integer(led)} of the {integer(compared)} "
        f"{and_join(names)} comparisons in the newest recorded run, so read each figure beside its table."
    )


def _machines(comparison: dict) -> str:
    labels: list[str] = []
    shared = (comparison.get("environment") or {}).get("machine_label")
    for engine in comparison.get("engines") or []:
        label = (engine.get("environment") or {}).get("machine_label") or shared
        if label and label not in labels:
            labels.append(label)
    if not labels and shared:
        labels.append(shared)
    return and_join(labels) if labels else "an unrecorded machine"


def headline_block(source: Source, benchmarks_link: str, reference: float | None) -> str:
    comparison = source.data
    keyword_rows = dataset_rows(comparison, "keyword", KEYWORD_DATASET)
    created = source.manifest.get("created_at")
    date = created[:10] if isinstance(created, str) and created else "an unrecorded date"
    sentences = [
        *_quality_sentences(keyword_rows, reference),
        _speed_sentence(keyword_rows, f"On {dataset_name(KEYWORD_DATASET)}", "keyword queries"),
        _vector_sentence(comparison),
        _tally_sentence(comparison),
        f"The harness recorded these figures in run `{source.run_id}` on {date}, on {_machines(comparison)}.",
        f"You'll find every dataset, every engine's settings, and the full method in "
        f"[`BENCHMARKS.md`]({benchmarks_link}).",
    ]
    return " ".join(sentence for sentence in sentences if sentence)


def readme_blocks(source: Source, target: ReadmeTarget) -> dict[str, str]:
    return {"headline": headline_block(source, target.benchmarks_link, reference_ndcg10(KEYWORD_DATASET))}
