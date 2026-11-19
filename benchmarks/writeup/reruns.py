from __future__ import annotations

import copy
from dataclasses import dataclass, replace
from pathlib import Path

from chart_data import BEST_CONFIG, EQUAL_PRECISION, PROFILE_TITLES, dataset_rows, peak_qps
from comparison_input import validated_comparison
from narsil_servers import DISPLAY_NAME_FIELD, engine_entry, engine_label, load_server_sources
from render import and_join, dataset_name, engine_name, integer
from sources import (
    BEST_CONFIG_COMPARISON_FILENAME,
    COMPARISON_FILENAME,
    MANIFEST_FILENAME,
    RERUN_FILENAME,
    SERVER_SUITE_DIR,
    Source,
    read_json,
    repo_root,
    run_directories,
    server_runs_root,
)

RERUNS_FIELD = "reruns"
RERUN_ROW_FIELD = "rerun"
PROFILE_COMPARISONS = {EQUAL_PRECISION: COMPARISON_FILENAME, BEST_CONFIG: BEST_CONFIG_COMPARISON_FILENAME}
DECLARED_TEXT_FIELDS = ("replaces_run", "profile", "engine", "dataset_id", "reason", "fix")


@dataclass(frozen=True)
class Rerun:
    run_id: str
    date: str
    report_link: str
    declaration: dict
    comparison: dict


def _declaration(path: Path) -> dict:
    declaration = read_json(path)
    for key in DECLARED_TEXT_FIELDS:
        value = declaration.get(key)
        if not isinstance(value, str) or not value.strip():
            raise SystemExit(f"benchmark writeup: {path} needs a non-empty {key}")
    if declaration["profile"] not in PROFILE_COMPARISONS:
        raise SystemExit(f"benchmark writeup: {path} names the unknown profile {declaration['profile']!r}")
    tracks = declaration.get("tracks")
    if not isinstance(tracks, list) or not tracks or any(not isinstance(name, str) for name in tracks):
        raise SystemExit(f"benchmark writeup: {path} needs a non-empty list of tracks")
    control = declaration.get("control_engine")
    if control is not None and (not isinstance(control, str) or control == declaration["engine"]):
        raise SystemExit(f"benchmark writeup: {path} needs a control engine other than the engine that it reran")
    return declaration


def _reruns_of(root: Path, base_run_id: str, profile: str) -> list[Rerun]:
    found = []
    for directory in run_directories(server_runs_root(root)):
        path = directory / RERUN_FILENAME
        if not path.is_file():
            continue
        declaration = _declaration(path)
        if declaration["replaces_run"] != base_run_id or declaration["profile"] != profile:
            continue
        filename = PROFILE_COMPARISONS[profile]
        created = read_json(directory / MANIFEST_FILENAME).get("created_at")
        found.append(Rerun(
            run_id=directory.name,
            date=created[:10] if isinstance(created, str) else "",
            report_link=f"{SERVER_SUITE_DIR}/results/runs/{directory.name}/{Path(filename).stem}.md",
            declaration=declaration,
            comparison=validated_comparison(read_json(directory / filename)),
        ))
    return found


def _engine_row(rows: list[dict], engine: str) -> dict | None:
    return next((row for row in rows if row.get("engine") == engine), None)


def _version(comparison: dict, engine: str) -> str:
    entry = engine_entry(comparison.get("engines") or [], engine) or {}
    return (entry.get("build_identity") or {}).get("version") or entry.get("version") or "n/a"


def _machine(comparison: dict, engine: str) -> str:
    entry = engine_entry(comparison.get("engines") or [], engine) or {}
    environment = entry.get("environment") or comparison.get("environment") or {}
    return environment.get("engine_machine_label") or environment.get("machine_label") or "an unlabelled machine"


def _replace_rows(data: dict, rerun: Rerun) -> None:
    declared = rerun.declaration
    engine, dataset_id = declared["engine"], declared["dataset_id"]
    marker = {"run_id": rerun.run_id, "version": _version(rerun.comparison, engine)}
    for track_name in declared["tracks"]:
        rows = dataset_rows(data, track_name, dataset_id)
        replacement = _engine_row(dataset_rows(rerun.comparison, track_name, dataset_id), engine)
        index = next((position for position, row in enumerate(rows) if row.get("engine") == engine), None)
        if replacement is None or index is None:
            raise SystemExit(
                f"benchmark writeup: run {rerun.run_id} replaces {engine} on {dataset_id} in the {track_name} "
                f"track, but run {rerun.run_id} or run {declared['replaces_run']} holds no such row"
            )
        kept = {key: rows[index][key] for key in (DISPLAY_NAME_FIELD,) if key in rows[index]}
        rows[index] = {**copy.deepcopy(replacement), **kept, RERUN_ROW_FIELD: marker}


def _control(base: dict, rerun: Rerun) -> dict | None:
    declared = rerun.declaration
    engine = declared.get("control_engine")
    if engine is None:
        return None
    track_name, dataset_id = declared["tracks"][0], declared["dataset_id"]
    before = _engine_row(dataset_rows(base, track_name, dataset_id), engine)
    after = _engine_row(dataset_rows(rerun.comparison, track_name, dataset_id), engine)
    if before is None or after is None:
        raise SystemExit(
            f"benchmark writeup: run {rerun.run_id} names {engine} as its control on {dataset_id}, but run "
            f"{rerun.run_id} or run {declared['replaces_run']} holds no such {track_name} row"
        )
    return {"engine": engine, "rerun_qps": peak_qps(after), "base_qps": peak_qps(before)}


def _note(base: Source, profile: str, rerun: Rerun) -> dict:
    declared = rerun.declaration
    return {
        "run_id": rerun.run_id,
        "base_run_id": base.run_id,
        "date": rerun.date,
        "report_link": rerun.report_link,
        "profile": profile,
        "engine": declared["engine"],
        "dataset_id": declared["dataset_id"],
        "tracks": list(declared["tracks"]),
        "version": _version(rerun.comparison, declared["engine"]),
        "machine": _machine(rerun.comparison, declared["engine"]),
        "reason": declared["reason"].strip().rstrip("."),
        "fix": declared["fix"],
        "control": _control(base.data, rerun),
    }


def with_reruns(source: Source, profile: str, root: Path) -> Source:
    reruns = _reruns_of(root, source.run_id, profile)
    if not reruns:
        return source
    data = copy.deepcopy(source.data)
    notes = []
    for rerun in reruns:
        notes.append(_note(source, profile, rerun))
        _replace_rows(data, rerun)
    data[RERUNS_FIELD] = notes
    return replace(source, data=data)


def published_server_sources(include_every_narsil_server: bool = False) -> tuple[Source, Source | None]:
    root = repo_root()
    server, best = load_server_sources(include_every_narsil_server)
    best_with_reruns = with_reruns(best, BEST_CONFIG, root) if best is not None else None
    return with_reruns(server, EQUAL_PRECISION, root), best_with_reruns


def _control_sentence(engines: list[dict], note: dict) -> str:
    control = note["control"]
    if control is None:
        return ""
    return (
        f" As a control, {engine_label(engines, control['engine'])} reached {integer(control['rerun_qps'])} queries a "
        f"second at its peak on that machine, against {integer(control['base_qps'])} in run `{note['base_run_id']}`."
    )


def rerun_bullets(comparison: dict | None) -> list[str]:
    if comparison is None:
        return []
    engines = comparison.get("engines") or []
    bullets = []
    for note in comparison.get(RERUNS_FIELD) or []:
        label = engine_label(engines, note["engine"])
        bullets.append(
            f"- **Rerun.** {label}'s {and_join(note['tracks'])} figures on {dataset_name(note['dataset_id'])} under "
            f"{PROFILE_TITLES[note['profile']]} come from run `{note['run_id']}`, in which the harness measured "
            f"{label} {note['version']} on {note['machine']} on {note['date']}. The harness reran that pass because "
            f"{note['reason']}. {label} {note['version']} includes [the fix]({note['fix']}). "
            f"[The rerun report]({note['report_link']}) lists the raw results.{_control_sentence(engines, note)}"
        )
    return bullets


def rerun_row_notes(rows: list[dict]) -> list[str]:
    notes = []
    for row in rows:
        marker = row.get(RERUN_ROW_FIELD)
        if not isinstance(marker, dict):
            continue
        label = row.get(DISPLAY_NAME_FIELD) or engine_name(row.get("engine") or "")
        notes.append(
            f"The Rerun bullet under the setup explains why the {label} row comes from run `{marker['run_id']}` on "
            f"{label} {marker['version']}."
        )
    return notes
