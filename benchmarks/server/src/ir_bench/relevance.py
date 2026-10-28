from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from pathlib import Path

from .core import datasets as ds
from .core.artifacts import dataset_slug
from .core.config import EngineConfig, load_config, select_datasets
from .core.keyword_relevance import load_keyword_index, score_keyword_queries
from .core.registry import build_driver
from .core.synonym_sets import SynonymRule, load_synonym_set, narsil_rules
from .core.wordnet_synonyms import OEWN_ATTRIBUTION, fetch_wordnet, wordnet_rules

SYNONYM_ENGINES = ("narsil", "elasticsearch")
DEFAULT_DATASETS = "beir/scifact/test,beir/nfcorpus/test"
WITHOUT_SET = "without-set"
WITH_SET = "with-set"
NDCG_AT_10 = "ndcg_cut_10"


def scratch_directory(path: Path) -> Path:
    resolved = path.resolve()
    if "results" in resolved.parts:
        raise SystemExit(f"{path} lies under a results directory; write relevance runs to a scratch directory")
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def _engine(config_engines: dict[str, EngineConfig], name: str, url: str | None) -> EngineConfig:
    if name not in SYNONYM_ENGINES:
        raise SystemExit(f"'{name}' takes no synonym set here; choose from {', '.join(SYNONYM_ENGINES)}")
    if name not in config_engines:
        raise SystemExit(f"the config names no engine '{name}'")
    engine = config_engines[name]
    return engine if url is None else dataclasses.replace(engine, url=url.rstrip("/"))


def _synonym_set(source: str | None, out: Path) -> tuple[tuple[SynonymRule, ...], str]:
    if source is not None:
        return load_synonym_set(Path(source)), str(Path(source).resolve())
    archive = fetch_wordnet(out / "wordnet")
    return wordnet_rules(archive), OEWN_ATTRIBUTION


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score keyword relevance with and without one synonym set, writing runs to a scratch directory."
    )
    parser.add_argument("--out", type=Path, required=True, help="scratch directory outside every results directory")
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--engines", default=",".join(SYNONYM_ENGINES))
    parser.add_argument("--datasets", default=DEFAULT_DATASETS)
    parser.add_argument("--synonyms", default=None, help="a JSON synonym set; Open English WordNet 2024 when absent")
    parser.add_argument("--narsil-url", default=None)
    parser.add_argument("--elasticsearch-url", default=None)
    parser.add_argument("--without-set-only", action="store_true")
    args = parser.parse_args(argv)

    out = scratch_directory(args.out)
    config = load_config(args.config)
    ds.configure(config.datasets, Path(os.environ.get("BENCH_EMBEDDINGS_DIR", str(out / "datasets"))))
    specs = select_datasets(config, args.datasets)
    urls = {"narsil": args.narsil_url, "elasticsearch": args.elasticsearch_url}
    engines = [_engine(config.engines, name.strip(), urls.get(name.strip())) for name in args.engines.split(",")]

    variants: list[tuple[str, tuple[SynonymRule, ...] | None]] = [(WITHOUT_SET, None)]
    source = None
    if not args.without_set_only:
        rules, source = _synonym_set(args.synonyms, out)
        (out / "synonyms.json").write_text(json.dumps(narsil_rules(rules)), encoding="utf-8")
        variants.append((WITH_SET, rules))

    figures: list[dict] = []
    for engine in engines:
        driver = build_driver(engine, config.bm25)
        try:
            driver.wait_until_ready()
            for spec in specs:
                queries = ds.load_queries(spec.dataset_id)
                qrels = ds.load_qrels(spec.dataset_id)
                for variant, rules in variants:
                    label = f"{engine.name}:{spec.dataset_id}:{variant}"
                    loaded = load_keyword_index(driver, config, spec, label, rules)
                    run_path = out / f"{engine.name}.{dataset_slug(spec.dataset_id)}.{variant}.run"
                    scores = score_keyword_queries(
                        driver, loaded.name, queries, qrels, config.run_depth, run_path, label
                    )
                    driver.drop_index(loaded.name)
                    figures.append(
                        {
                            "engine": engine.name,
                            "dataset": spec.dataset_id,
                            "variant": variant,
                            "documents": loaded.documents,
                            "ndcg_at_10": None if scores.metrics is None else scores.metrics[NDCG_AT_10],
                            "run_file": scores.run_file,
                        }
                    )
        finally:
            driver.close()

    report = {"synonym_set": source, "figures": figures}
    (out / "relevance.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n| Engine | Dataset | Variant | nDCG@10 |\n|---|---|---|---:|")
    for figure in figures:
        value = figure["ndcg_at_10"]
        print(f"| {figure['engine']} | {figure['dataset']} | {figure['variant']} | {'' if value is None else f'{value:.4f}'} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
