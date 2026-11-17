from __future__ import annotations

from chart_data import tracks
from headline_section import reference_ndcg10
from narsil_servers import NARSIL_TYPESCRIPT, is_narsil_server, is_unmeasured
from render import and_join, dataset_name, decimal, engine_name, integer, is_number, percent
from sources import Source

ROOT_README = "README.md"
PACKAGE_README = "packages/ts/README.md"
BEIR_LINK = "[BEIR](https://github.com/beir-cellar/beir)"
QUALITY_TRACKS = ("keyword", "vector", "hybrid")
NDCG = ("ndcg_cut_10", "nDCG@10")
KEYWORD_METRICS = (NDCG, ("recall_100", "Recall@100"), ("map", "MAP"), ("recip_rank", "MRR"))
TIE_PLACES = 4
REFERENCE_PLACES = 3
LATENCY_PLACES = 3
INPROCESS_NARSIL = "narsil"
INPROCESS_ENGINE_ORDER = ("narsil", "orama", "minisearch")
SHARED_STOP_WORD_COUNT = 33
_COUNT_WORDS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine"}


def _count_word(count: int) -> str:
    return _COUNT_WORDS.get(count, integer(count))


def _rounded(value: float | None) -> float | None:
    return round(value, TIE_PLACES) if value is not None else None


def _server_metric(row: dict | None, key: str) -> float | None:
    value = ((row or {}).get("metrics") or {}).get(key)
    return float(value) if is_number(value) else None


def _judged_rows(rows: list[dict]) -> tuple[dict | None, list[dict]]:
    measured = [row for row in rows if not is_unmeasured(row) and _server_metric(row, NDCG[0]) is not None]
    narsil = next((row for row in measured if row.get("engine") == NARSIL_TYPESCRIPT), None)
    rivals = [row for row in measured if not is_narsil_server(row.get("engine"))]
    return narsil, rivals


def _judged_datasets(comparison: dict, track_name: str) -> list[tuple[str, dict, list[dict]]]:
    judged = []
    for entry in tracks(comparison):
        if entry.get("track") != track_name:
            continue
        for dataset in entry.get("datasets") or []:
            narsil, rivals = _judged_rows(list(dataset.get("rows") or []))
            if narsil is not None and rivals:
                judged.append((dataset.get("dataset_id") or "", narsil, rivals))
    return judged


def _verb(names: list[str], singular: str, plural: str) -> str:
    return singular if len(names) == 1 else plural


def _track_sentences(track_name: str, judged: list[tuple[str, dict, list[dict]]]) -> list[str]:
    led: list[str] = []
    tied: list[str] = []
    trailing: list[str] = []
    for dataset_id, narsil, rivals in judged:
        name = dataset_name(dataset_id)
        ours = _rounded(_server_metric(narsil, NDCG[0]))
        best = max(_rounded(_server_metric(row, NDCG[0])) or 0.0 for row in rivals)
        if ours is None:
            continue
        if ours > best:
            led.append(name)
            continue
        if ours == best:
            tied.append(name)
            continue
        leaders = [
            engine_name(row.get("engine") or "") for row in rivals if _rounded(_server_metric(row, NDCG[0])) == best
        ]
        trailing.append(
            f"{and_join(leaders)} {_verb(leaders, 'has', 'have')} the highest nDCG@10 on {name}, at "
            f"{decimal(best, TIE_PLACES)} against Narsil's {decimal(ours, TIE_PLACES)}."
        )
    opening = f"On the {track_name} track, "
    claims = []
    if led:
        claims.append(f"has the highest nDCG@10 on {and_join(led)}")
    if tied:
        claims.append(f"ties for the highest{'' if led else ' nDCG@10'} on {and_join(tied)}")
    if not claims:
        if trailing:
            trailing[0] = opening + trailing[0]
        return trailing
    first = f"{opening}Narsil {' and '.join(claims)}"
    if not trailing:
        return [f"{first}."]
    return [f"{first}, while {trailing[0]}", *trailing[1:]]


def _keyword_extras(judged: list[tuple[str, dict, list[dict]]]) -> list[str]:
    parts = []
    for dataset_id, narsil, rivals in judged:
        led = []
        for key, label in KEYWORD_METRICS:
            ours = _rounded(_server_metric(narsil, key))
            others = [_rounded(_server_metric(row, key)) for row in rivals]
            if ours is not None and all(value is not None and ours > value for value in others):
                led.append(label)
        extras = [label for label in led if label != NDCG[1]]
        if NDCG[1] in led and extras:
            parts.append(f"the highest {and_join(extras)} on {dataset_name(dataset_id)}")
    return [f"Narsil's BM25 ranking also has {and_join(parts)}."] if parts else []


def _reference_sentence(judged: list[tuple[str, dict, list[dict]]]) -> str | None:
    pairs = []
    for dataset_id, narsil, _rivals in judged:
        reference = reference_ndcg10(dataset_id)
        ours = _server_metric(narsil, NDCG[0])
        if reference is not None and ours is not None:
            pairs.append((dataset_name(dataset_id), ours, reference))
    if not pairs:
        return None
    scores = and_join([f"{decimal(ours, REFERENCE_PLACES)} on {name}" for name, ours, _ in pairs])
    references = and_join([decimal(reference, REFERENCE_PLACES) for _, _, reference in pairs])
    noun = "reference" if len(pairs) == 1 else "references"
    return f"Narsil's BM25 nDCG@10 is {scores}, against the published Anserini {noun} of {references}."


def _measured_engines(comparison: dict) -> list[str]:
    names: list[str] = []
    for entry in tracks(comparison):
        for dataset in entry.get("datasets") or []:
            for row in dataset.get("rows") or []:
                name = row.get("engine")
                if isinstance(name, str) and not is_unmeasured(row) and name not in names:
                    names.append(name)
    return names


def servers_paragraph(server: Source) -> str:
    comparison = server.data
    judged_by_track = {name: _judged_datasets(comparison, name) for name in QUALITY_TRACKS}
    judged_names = []
    for judged in judged_by_track.values():
        for dataset_id, _narsil, _rivals in judged:
            if dataset_name(dataset_id) not in judged_names:
                judged_names.append(dataset_name(dataset_id))
    engines = _measured_engines(comparison)
    sentences = []
    if judged_names:
        sentences.append(
            f"Over HTTP, the harness scores the ranking of {_count_word(len(engines))} engines against the human "
            f"relevance judgements of the {BEIR_LINK} {and_join(judged_names)} datasets."
        )
    for name in QUALITY_TRACKS:
        sentences.extend(_track_sentences(name, judged_by_track[name]))
        if name == "keyword":
            sentences.extend(_keyword_extras(judged_by_track[name]))
    reference = _reference_sentence(judged_by_track["keyword"])
    if reference:
        sentences.append(reference)
    sentences.append(
        f"[BENCHMARKS.md](BENCHMARKS.md) lists the keyword, vector, and hybrid figures for all "
        f"{_count_word(len(engines))} engines."
    )
    return " ".join(sentences)


def _dig(node: object, *path: str) -> float | None:
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return float(node) if is_number(node) else None


def _present(results: dict) -> list[str]:
    engines = results.get("engines") or {}
    return [name for name in INPROCESS_ENGINE_ORDER if name in engines]


def _ndcg_leaders(results: dict, engines: list[str]) -> list[str]:
    quality = results.get("relevanceQuality") or {}
    scores = {name: _rounded(_dig(quality, name, "meanNdcg10")) for name in engines}
    best = max((score for score in scores.values() if score is not None), default=None)
    return [name for name, score in scores.items() if best is not None and score == best]


def _leaders_clause(leaders: list[str]) -> str:
    names = [engine_name(name) for name in leaders]
    if len(names) == 1:
        return f"{names[0]} has the highest nDCG@10"
    return f"{and_join(names)} share the highest nDCG@10"


def _relevance_name(results: dict) -> str:
    return dataset_name((results.get("relevanceDataset") or {}).get("name") or "")


def _others_phrase(others: list[str]) -> str:
    return "both libraries" if len(others) == 2 else and_join([engine_name(name) for name in others])


def _scale_phrase(scales: list[str], every: list[str]) -> str:
    if scales == every:
        return "at every scale that we measure"
    return f"at {and_join([integer(int(scale)) for scale in scales])} documents"


def _scale_winners(results: dict, engines: list[str], path: tuple[str, ...], lower_wins: bool) -> dict[str, str]:
    textonly = (results.get("tiers") or {}).get("textOnly") or {}
    winners = {}
    for scale in [str(scale) for scale in ((results.get("config") or {}).get("scales") or [])]:
        values = {name: _dig(textonly, name, scale, *path) for name in engines}
        measured = {name: value for name, value in values.items() if value is not None}
        if INPROCESS_NARSIL in measured and len(measured) > 1:
            pick = min if lower_wins else max
            winners[scale] = pick(measured, key=lambda name: measured[name])
    return winners


def _insert_sentences(results: dict, engines: list[str], others: list[str]) -> list[str]:
    winners = _scale_winners(results, engines, ("insertDocsPerSec",), lower_wins=False)
    every = list(winners)
    ours = [scale for scale, name in winners.items() if name == INPROCESS_NARSIL]
    sentences = []
    if ours:
        sentences.append(f"Narsil inserts text faster than {_others_phrase(others)} {_scale_phrase(ours, every)}.")
    for name in dict.fromkeys(name for name in winners.values() if name != INPROCESS_NARSIL):
        scales = [scale for scale, winner in winners.items() if winner == name]
        sentences.append(f"{engine_name(name)} inserts text fastest {_scale_phrase(scales, every)}.")
    return sentences


def _search_sentences(results: dict, engines: list[str], follows_narsil: bool) -> list[str]:
    path = ("searchLatency", "p50Ms")
    winners = _scale_winners(results, engines, path, lower_wins=True)
    every = list(winners)
    textonly = (results.get("tiers") or {}).get("textOnly") or {}
    ours = [scale for scale, name in winners.items() if name == INPROCESS_NARSIL]
    sentences = []
    if ours:
        sentences.append(
            f"{'It also' if follows_narsil else 'Narsil'} has the lowest median search latency of the "
            f"{_count_word(len(engines))} "
            f"{_scale_phrase(ours, every)}."
        )
    for scale, name in winners.items():
        if name == INPROCESS_NARSIL:
            continue
        sentences.append(
            f"At {integer(int(scale))} documents, {engine_name(name)} searches fastest, with a median of "
            f"{decimal(_dig(textonly, name, scale, *path), LATENCY_PLACES)} ms against Narsil's "
            f"{decimal(_dig(textonly, INPROCESS_NARSIL, scale, *path), LATENCY_PLACES)} ms."
        )
    return sentences


def _vector_record(results: dict, engine: str, dataset: str) -> dict:
    return ((results.get("vectorRelevance") or {}).get(engine) or {}).get(dataset) or {}


def _fastest(records: dict[str, dict], path: tuple[str, ...], lower_wins: bool) -> str | None:
    values = {name: _dig(record, *path) for name, record in records.items()}
    measured = {name: value for name, value in values.items() if value is not None}
    if not measured:
        return None
    pick = min if lower_wins else max
    return pick(measured, key=lambda name: measured[name])


def _vector_sentence(names: list[str], key: tuple[str, str, bool], rivals: list[str]) -> str:
    searcher, inserter, same_recall = key
    datasets = and_join(names)
    recall = " at the same recall" if same_recall else ""
    if searcher == INPROCESS_NARSIL:
        slower = and_join([engine_name(name) for name in rivals])
        sentence = f"Narsil searches vectors faster than {slower}{recall} on {datasets}"
    else:
        sentence = f"{engine_name(searcher)} searches vectors faster than Narsil{recall} on {datasets}"
    if inserter == searcher:
        return f"{sentence}, and {engine_name(searcher)} also inserts them faster."
    return f"{sentence}, although {engine_name(inserter)} inserts them faster."


def _vector_sentences(results: dict, engines: list[str]) -> list[str]:
    vector = results.get("vectorRelevance") or {}
    with_vectors = [name for name in engines if name in vector]
    without = [name for name in engines if name not in vector]
    rivals = [name for name in with_vectors if name != INPROCESS_NARSIL]
    if INPROCESS_NARSIL not in with_vectors or not rivals:
        return []
    sentences = []
    if without:
        names = [engine_name(name) for name in without]
        sentences.append(
            f"Because {and_join(names)} {_verb(names, 'has', 'have')} no vector search, we compare vector search "
            f"against {and_join([engine_name(name) for name in rivals])} alone."
        )
    groups: dict[tuple[str, str, bool], list[str]] = {}
    for dataset in (results.get("config") or {}).get("vectorDatasets") or []:
        records = {name: _vector_record(results, name, dataset) for name in with_vectors}
        searcher = _fastest(records, ("searchLatency", "p50Ms"), lower_wins=True)
        inserter = _fastest(records, ("insertDocsPerSec",), lower_wins=False)
        recalls = {_rounded(_dig(record, "meanRecallAt10")) for record in records.values()}
        if searcher is None or inserter is None:
            continue
        same_recall = len(recalls) == 1 and None not in recalls
        if same_recall:
            groups.setdefault((searcher, inserter, True), []).append(dataset_name(dataset))
            continue
        sentences.append(_vector_sentence([dataset_name(dataset)], (searcher, inserter, False), rivals))
        sentences.append(_recall_sentence(records, dataset_name(dataset)))
    sentences.extend(_vector_sentence(names, key, rivals) for key, names in groups.items())
    return sentences


def _recall_sentence(records: dict[str, dict], dataset: str) -> str:
    clauses = [
        f"{engine_name(name)} finds {percent(_dig(record, 'meanRecallAt10'))}" for name, record in records.items()
    ]
    first, rest = clauses[0], clauses[1:]
    sentence = f"On {dataset}, {first} of the ten nearest neighbours that an exact search returns"
    return f"{sentence}, while {and_join(rest)}." if rest else f"{sentence}."


def inprocess_paragraph(inprocess: Source) -> str:
    results = inprocess.data
    engines = _present(results)
    others = [name for name in engines if name != INPROCESS_NARSIL]
    leaders = _ndcg_leaders(results, engines)
    count = _count_word(len(engines))
    sentences = []
    if others:
        sentences.append(
            f"We measure Narsil in one process against {and_join([engine_name(name) for name in others])}, giving "
            f"all {count} the same stop words and default BM25 parameters, although each library stems English "
            "differently."
        )
    if others and leaders:
        sentences.append(f"On BEIR {_relevance_name(results)}, {_leaders_clause(leaders)} of the {count}.")
    inserts = _insert_sentences(results, engines, others)
    sentences.extend(inserts)
    sentences.extend(_search_sentences(results, engines, bool(inserts) and inserts[-1].startswith("Narsil")))
    sentences.extend(_vector_sentences(results, engines))
    sentences.append(
        "[BENCHMARKS.md](BENCHMARKS.md) contains the full quality, throughput, and latency tables. For the method and "
        "the steps to reproduce them, read [`benchmarks/in-process`](benchmarks/in-process)."
    )
    return " ".join(sentences)


def quality_paragraph(inprocess: Source) -> str:
    results = inprocess.data
    engines = _present(results)
    others = [name for name in engines if name != INPROCESS_NARSIL]
    dataset = results.get("relevanceDataset") or {}
    quality = results.get("relevanceQuality") or {}
    count = _count_word(len(engines))
    sentences = [
        f"We measure ranking quality on the {BEIR_LINK} {_relevance_name(results)} corpus, which contains "
        f"{integer(dataset.get('documents'))} documents and {integer(dataset.get('queries'))} queries with human "
        "relevance judgements."
    ]
    if not others:
        return " ".join(sentences)
    sentences.append(f"We compare Narsil with {and_join([engine_name(name) for name in others])} in one process.")
    sentences.append(
        f"All {count} use the same {SHARED_STOP_WORD_COUNT} Lucene English stop words and default BM25 parameters, "
        "although each one stems English differently."
    )
    leaders = _ndcg_leaders(results, engines)
    if leaders:
        ranked = sorted(engines, key=lambda name: _dig(quality, name, "meanNdcg10") or -1.0, reverse=True)
        scores = and_join(
            [f"{decimal(_dig(quality, name, 'meanNdcg10'), TIE_PLACES)} for {engine_name(name)}" for name in ranked]
        )
        sentences.append(f"{_leaders_clause(leaders)} of the {count}, with scores of {scores}.")
    return " ".join(sentences)


def readme_result_blocks(readme_path: str, server: Source, inprocess: Source) -> dict[str, str]:
    if readme_path == ROOT_README:
        return {"readme-servers": servers_paragraph(server), "readme-inprocess": inprocess_paragraph(inprocess)}
    if readme_path == PACKAGE_README:
        return {"readme-quality": quality_paragraph(inprocess)}
    return {}
