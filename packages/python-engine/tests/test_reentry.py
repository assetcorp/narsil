from __future__ import annotations

import json
import subprocess
import sys
from typing import Any

import pytest

from tests.conftest import PACKAGE_ROOT

CHILD_TIMEOUT_SECONDS = 60
WAITING_PHRASE = "called the engine that is waiting for it to return"


def run_scenario(name: str) -> dict[str, Any]:
    try:
        finished = subprocess.run(
            [sys.executable, "-m", "tests.reentry_scenarios", name],
            capture_output=True,
            check=False,
            cwd=PACKAGE_ROOT,
            text=True,
            timeout=CHILD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f"the {name} scenario hung for {CHILD_TIMEOUT_SECONDS} seconds")
    assert finished.returncode == 0, f"the {name} scenario crashed: {finished.stderr}"
    result: dict[str, Any] = json.loads(finished.stdout.strip().splitlines()[-1])
    return result


SUCCEEDED = {"code": None, "message": None}


@pytest.mark.parametrize(
    ("scenario", "subject", "documents"),
    [
        ("tokenizer_refused", "The tokenizer", 1),
        ("stop_words_refused", "The stop word function", 2),
        ("persistence_refused", "The save method of the persistence adapter", 0),
        ("persistence_refused_on_background_thread", "The save method of the persistence adapter", 1),
        ("id_generator_refused", "The idGenerator", 1),
        ("embedding_refused", "The embedding adapter", 1),
        ("restore_source_refused", "The source", 1),
    ],
)
def test_a_callback_that_calls_its_engine_is_refused_and_the_outer_call_finishes(
    scenario: str, subject: str, documents: int
) -> None:
    result = run_scenario(scenario)
    assert result["outer"] == SUCCEEDED
    assert len(result["inner"]) == 1
    refusal = result["inner"][0]
    assert refusal["code"] == "CONFIG_INVALID"
    assert refusal["message"].startswith(subject)
    assert WAITING_PHRASE in refusal["message"]
    assert result["count"] == documents


def test_a_refusal_that_the_tokenizer_lets_through_fails_the_insert_and_keeps_the_index() -> None:
    result = run_scenario("tokenizer_propagated")
    assert result["outer"]["code"] == "CONFIG_INVALID"
    assert result["outer"]["message"].startswith("The tokenizer")
    assert result["after_failure"] == 1
    assert result["count"] == 2
    assert result["found"] == 1


def test_a_tokenizer_can_write_to_another_engine() -> None:
    result = run_scenario("other_engine_allowed")
    assert result["outer"] == SUCCEEDED
    assert result["inner"] == [SUCCEEDED]
    assert result["count"] == 1
    assert result["other_count"] == 1


@pytest.mark.parametrize("scenario", ["plugin_hook_allowed", "listener_allowed", "rerank_allowed"])
def test_a_hook_a_listener_and_a_rerank_adapter_can_write_to_and_close_the_index_that_called_them(
    scenario: str,
) -> None:
    result = run_scenario(scenario)
    assert result["outer"] == SUCCEEDED
    assert result["inner"] == [SUCCEEDED, SUCCEEDED]
    assert result["count"] == 2


def test_a_listener_that_a_tokenizer_fails_to_remove_can_be_removed_once_the_insert_returns() -> None:
    result = run_scenario("listener_off_refused")
    assert result["inner"][0]["code"] == "CONFIG_INVALID"
    assert result["outer"] == SUCCEEDED
    assert result["removed"] is True
    assert result["events"] == 1
    assert result["count"] == 2
