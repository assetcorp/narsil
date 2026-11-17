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

from chart_data import dataset_rows, peak_qps, recall_unrecorded, tracks
from narsil_servers import (
    NARSIL_RUST,
    NARSIL_TYPESCRIPT,
    NOT_MEASURED_TEXT,
    comparison_rows,
    is_narsil_server,
    is_unmeasured,
)
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
REPOSITORY_FILE_URL = "https://github.com/assetcorp/narsil/blob/main"
_QUALITY_METRIC = "ndcg_cut_10"
NDCG_SIGNIFICANCE_FIELD = "ndcg_significance"


@dataclass(frozen=True)
class ReadmeTarget:
    path: str
    benchmarks_link: str


README_TARGETS = (
    ReadmeTarget("README.md", "BENCHMARKS.md"),
    ReadmeTarget("packages/ts/README.md", f"{REPOSITORY_FILE_URL}/BENCHMARKS.md"),
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
    return not recall_unrecorded(row) and (not isinstance(point, dict) or point.get("met_target") is not False)


def _unranked_sentence(row: dict, subject: str) -> str:
    reason = "has no recorded recall result" if recall_unrecorded(row) else "misses the recall target"
    return f"{subject} {reason}, so the comparison leaves its speed unranked."


def _quality_sentences(rows: list[dict], reference: float | None, pairs: list[dict]) -> list[str]:
    narsil = _ndcg10(_row(rows, "narsil"))
    if narsil is None:
        return []
    rust = _row(rows, NARSIL_RUST)
    ranking = "Narsil's BM25 ranking" if rust is None or is_unmeasured(rust) else "the BM25 ranking of Narsil's TypeScript server"
    sentence = f"On BEIR {dataset_name(KEYWORD_DATASET)}, {ranking} scores {decimal(narsil, 3)} nDCG@10"
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
        verdict = _significance_sentence(rows, pairs)
        if verdict:
            sentences.append(verdict)
    return sentences


def _pair(pairs: list[dict], first: str, second: str) -> dict | None:
    return next((pair for pair in pairs if set(pair.get("engines") or []) == {first, second}), None)


def _narsil_advantage(pair: dict) -> float:
    difference = float(pair.get("mean_difference") or 0.0)
    return difference if (pair.get("engines") or [None])[0] == NARSIL_TYPESCRIPT else -difference


def _significance_sentence(rows: list[dict], pairs: list[dict]) -> str | None:
    rivals = [name for name in BM25_ENGINES if _ndcg10(_row(rows, name)) is not None]
    tested = [_pair(pairs, NARSIL_TYPESCRIPT, name) for name in rivals]
    if not rivals or any(pair is None for pair in tested):
        return None
    names = [engine_name(name) for name in rivals]
    opening = "A paired significance test over those queries finds"
    if not any(pair.get("significant") is True for pair in tested if pair is not None):
        return f"{opening} no significant difference between {and_join(['Narsil', *names])}."
    if not all(pair.get("significant") is True for pair in tested if pair is not None):
        return None
    if all(_narsil_advantage(pair) > 0 for pair in tested if pair is not None):
        return f"{opening} Narsil's lead over {and_join(names)} significant."
    if all(_narsil_advantage(pair) < 0 for pair in tested if pair is not None):
        return f"{opening} the lead of {and_join(names)} over Narsil significant."
    return None


def _keyword_pairs(comparison: dict) -> list[dict]:
    for entry in tracks(comparison):
        if entry.get("track") != "keyword":
            continue
        for dataset in entry.get("datasets", []):
            if dataset.get("dataset_id") == KEYWORD_DATASET:
                return list((dataset.get(NDCG_SIGNIFICANCE_FIELD) or {}).get("pairs") or [])
    return []


def _rust_sentence(rust: dict | None, queries: str) -> str:
    if rust is None or is_unmeasured(rust):
        return ""
    rust_peak = peak_qps(rust)
    if rust_peak is None:
        return ""
    if not _met_its_recall_target(rust):
        return " " + _unranked_sentence(rust, "Narsil's Rust server")
    return f" Narsil's Rust server answers {integer(rust_peak)} {queries} a second at its peak."


def _speed_sentence(rows: list[dict], opening: str, queries: str) -> str | None:
    """One sentence for Narsil's peak on a row, beside the fastest other engine that
    met the row's recall target, whether that engine leads Narsil or follows it."""

    narsil = _row(rows, NARSIL_TYPESCRIPT)
    narsil_peak = peak_qps(narsil) if narsil is not None else None
    rust = _row(rows, NARSIL_RUST)
    if narsil is None or narsil_peak is None:
        sentence = _rust_sentence(rust, queries).strip()
        return f"{opening}, {sentence}" if sentence else None
    subject = "Narsil" if rust is None else "Narsil's TypeScript server"
    rust_sentence = _rust_sentence(rust, queries)
    if not _met_its_recall_target(narsil):
        return f"{opening}, {_unranked_sentence(narsil, subject)}{rust_sentence}"
    others = [
        row
        for row in rows
        if not is_narsil_server(row.get("engine")) and peak_qps(row) is not None and _met_its_recall_target(row)
    ]
    sentence = f"{opening}, {subject} answers {integer(narsil_peak)} {queries} a second at its peak"
    fastest = max(others, key=lambda row: peak_qps(row) or 0.0, default=None)
    if fastest is None:
        return f"{sentence}.{rust_sentence}"
    fastest_peak = peak_qps(fastest) or 0.0
    name = engine_name(fastest.get("engine") or "")
    if fastest_peak > narsil_peak:
        return f"{sentence}, while {name} leads with {integer(fastest_peak)}.{rust_sentence}"
    return f"{sentence}, and {name} follows with {integer(fastest_peak)}.{rust_sentence}"


def _largest_vector_dataset(comparison: dict) -> tuple[str, list[dict]] | None:
    for dataset_id in VECTOR_DATASETS_LARGEST_FIRST:
        rows = dataset_rows(comparison, "vector", dataset_id)
        if any(is_narsil_server(row.get("engine")) and peak_qps(row) is not None for row in rows):
            return dataset_id, rows
    return None


def _vector_sentence(comparison: dict) -> str | None:
    largest = _largest_vector_dataset(comparison)
    if largest is None:
        return None
    dataset_id, rows = largest
    target = (comparison.get("config") or {}).get("recall_target")
    measured = [row for row in rows if not is_unmeasured(row)]
    held = ""
    if is_number(target):
        held = (
            f" with every engine held at {decimal(target, 2)} recall"
            if all(_met_its_recall_target(row) for row in measured)
            else f" at a recall target of {decimal(target, 2)}"
        )
    return _speed_sentence(rows, f"On {dataset_name(dataset_id)}{held}", "vector queries")


def _production_vector_sentence(comparison: dict, production: dict | None) -> str | None:
    largest = _largest_vector_dataset(production) if production is not None else None
    if largest is None:
        return None
    dataset_id, rows = largest
    equal = _largest_vector_dataset(comparison)
    place = "on the same set" if equal is not None and equal[0] == dataset_id else f"on {dataset_name(dataset_id)}"
    return _speed_sentence(rows, f"With each engine's recommended production settings {place}", "vector queries")


@dataclass(frozen=True)
class _Tally:
    led: int
    compared: int
    tracks: tuple[str, ...]


def _tally(comparison: dict) -> _Tally:
    compared = 0
    led = 0
    names: list[str] = []
    for entry in tracks(comparison):
        for dataset in entry.get("datasets", []):
            rows = [row for row in dataset.get("rows", []) if peak_qps(row) is not None]
            rivals = [row for row in rows if not is_narsil_server(row.get("engine"))]
            if not rivals or not any(is_narsil_server(row.get("engine")) for row in rows):
                continue
            compared += 1
            if entry.get("track") not in names:
                names.append(entry.get("track"))
            ranked = [row for row in rows if _met_its_recall_target(row)]
            best = max(ranked, key=lambda row: peak_qps(row) or 0.0, default=None)
            if best is not None and any(
                is_narsil_server(row.get("engine")) and peak_qps(row) == peak_qps(best) for row in ranked
            ):
                led += 1
    return _Tally(led=led, compared=compared, tracks=tuple(names))


def _share(tally: _Tally) -> str:
    if tally.led == tally.compared and tally.compared > 1:
        return f"all {integer(tally.compared)}"
    return f"{integer(tally.led)} of {integer(tally.compared)}"


def _tally_sentence(comparison: dict, production: dict | None) -> str | None:
    equal = _tally(comparison)
    tuned = _tally(production) if production is not None else _Tally(led=0, compared=0, tracks=())
    compared = equal.compared + tuned.compared
    if compared == 0:
        return None
    names = [*equal.tracks, *(name for name in tuned.tracks if name not in equal.tracks)]
    sentence = (
        f"Narsil has the highest peak throughput in {integer(equal.led + tuned.led)} of the {integer(compared)} "
        f"{and_join(names)} comparisons in the newest recorded run"
    )
    if equal.compared == 0 or tuned.compared == 0:
        return f"{sentence}."
    return (
        f"{sentence}: {_share(equal)} with every engine on equal settings, and {_share(tuned)} with each "
        "engine's recommended production settings."
    )


def _machine_labels(comparison: dict) -> list[str]:
    labels: list[str] = []
    shared = (comparison.get("environment") or {}).get("machine_label")
    for engine in comparison.get("engines") or []:
        label = (engine.get("environment") or {}).get("machine_label") or shared
        if label and label not in labels:
            labels.append(label)
    if not labels and shared:
        labels.append(shared)
    return labels


def _machine_sentence(comparison: dict) -> str:
    labels = _machine_labels(comparison)
    if not labels:
        return "The harness recorded no machine label."
    machine_types = {label.rpartition(", ")[0] or label for label in labels}
    if len(machine_types) > 1:
        return f"Machines of {integer(len(machine_types))} different types hosted the engines."
    machine_type = machine_types.pop()
    places = sorted({label.rpartition(", ")[2] for label in labels if ", " in label})
    if not places:
        return f"{machine_type} hosted the engines."
    return f"{machine_type} hardware in {and_join(places)} hosted the engines."


def _rust_unmeasured_sentence(comparison: dict, production: dict | None) -> str | None:
    rust_rows = [
        row
        for source in (comparison, production)
        if source is not None
        for row in comparison_rows(source)
        if row.get("engine") == NARSIL_RUST
    ]
    if not rust_rows or not all(is_unmeasured(row) for row in rust_rows):
        return None
    return f"Narsil's Rust server is {NOT_MEASURED_TEXT}."


def headline_block(
    source: Source, benchmarks_link: str, reference: float | None, production: Source | None = None
) -> str:
    comparison = source.data
    production_comparison = production.data if production is not None else None
    keyword_rows = dataset_rows(comparison, "keyword", KEYWORD_DATASET)
    created = source.manifest.get("created_at")
    date = created[:10] if isinstance(created, str) and created else "an unrecorded date"
    sentences = [
        *_quality_sentences(keyword_rows, reference, _keyword_pairs(comparison)),
        _speed_sentence(keyword_rows, f"On {dataset_name(KEYWORD_DATASET)}", "keyword queries"),
        _vector_sentence(comparison),
        _production_vector_sentence(comparison, production_comparison),
        _tally_sentence(comparison, production_comparison),
        f"The harness recorded these figures on {date} in run `{source.run_id}`.",
        _machine_sentence(comparison),
        f"You'll find every dataset, every engine's settings, and the full method in "
        f"[`BENCHMARKS.md`]({benchmarks_link}).",
        _rust_unmeasured_sentence(comparison, production_comparison),
    ]
    return " ".join(sentence for sentence in sentences if sentence)


def readme_blocks(source: Source, target: ReadmeTarget, production: Source | None = None) -> dict[str, str]:
    return {
        "headline": headline_block(
            source, target.benchmarks_link, reference_ndcg10(KEYWORD_DATASET), production
        )
    }
