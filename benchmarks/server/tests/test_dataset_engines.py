from __future__ import annotations

import pytest

from ir_bench.core.config_datasets import DatasetSpec
from ir_bench.core.dataset_engines import DatasetEnginesError, datasets_for_engine, parse_dataset_engines

DATASETS = ("beir/scifact/test", "beir/nfcorpus/test", "dbpedia-entities-openai-100k")
ENGINES = ("narsil", "elasticsearch", "qdrant", "typesense")


def _spec(dataset_id: str) -> DatasetSpec:
    return DatasetSpec(dataset_id=dataset_id, baseline_ndcg10=None, margin=0.02, baseline_source="")


def test_an_empty_or_absent_value_maps_nothing():
    assert parse_dataset_engines(None, DATASETS, ENGINES) == {}
    assert parse_dataset_engines("  ", DATASETS, ENGINES) == {}


def test_a_value_maps_each_named_dataset_to_its_engines():
    mapping = parse_dataset_engines(
        "dbpedia-entities-openai-100k=narsil, elasticsearch,qdrant; beir/scifact/test=typesense;", DATASETS, ENGINES
    )
    assert mapping == {
        "dbpedia-entities-openai-100k": ("narsil", "elasticsearch", "qdrant"),
        "beir/scifact/test": ("typesense",),
    }


@pytest.mark.parametrize(
    "value",
    [
        "dbpedia-entities-openai-100k",
        "=narsil",
        "beir/nq=narsil",
        "beir/scifact/test=",
        "beir/scifact/test=narsil,solr",
        "beir/scifact/test=narsil;beir/scifact/test=qdrant",
    ],
)
def test_a_malformed_or_unknown_value_is_rejected(value):
    with pytest.raises(DatasetEnginesError):
        parse_dataset_engines(value, DATASETS, ENGINES)


def test_an_engine_keeps_every_unmapped_dataset_and_only_the_mapped_ones_that_name_it():
    specs = tuple(_spec(dataset_id) for dataset_id in DATASETS)
    mapping = {"dbpedia-entities-openai-100k": ("narsil", "qdrant")}
    assert [spec.dataset_id for spec in datasets_for_engine(specs, "typesense", mapping)] == list(DATASETS[:2])
    assert [spec.dataset_id for spec in datasets_for_engine(specs, "qdrant", mapping)] == list(DATASETS)
    assert datasets_for_engine(specs, "qdrant", {}) == specs
