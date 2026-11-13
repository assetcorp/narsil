import argparse
import json
import platform
import sys
from pathlib import Path

import snowballstemmer
from text_oracle.analysis import EnglishAnalyser
from text_oracle.reference_module import PINNED_ENGLISH_REVISION, ModuleError, english_module

from .answers import parse_runner_answers
from .checks import OutputCheck, check_hybrid, check_keyword, check_vector
from .cross_engine import recall_comparisons, score_disagreements
from .truth import ExactVectors, TextOracle, load_truth, truth_key
from .workload import UnusableInput, Workload, load_workload, read_json

EXIT_PASSED = 0
EXIT_FAILED = 1
EXIT_UNUSABLE = 2
STEMMER_LANGUAGE = "english"


def output_summary(check: OutputCheck) -> dict:
    return {
        "source": check.source,
        "engine": check.engine,
        "workload": check.workload,
        "threads": check.threads,
        "failureCount": check.failure_count,
        "recall10": check.mean("recall10"),
        "recall100": check.mean("recall100"),
        "hybridRecall10": check.mean("hybridRecall10"),
        "maxVectorScoreError": check.max_vector_score_error if check.workload == "vector" else None,
    }


def check_outputs(workload: Workload, truth_path: Path, outputs: list[Path]) -> dict:
    module = english_module()
    analyser = EnglishAnalyser(module.stop_words, snowballstemmer.stemmer(STEMMER_LANGUAGE).stemWord)
    exact = ExactVectors([document["id"] for document in workload.vector_documents], workload.vector_document_vectors)
    identity = f"{PINNED_ENGLISH_REVISION}/{module.snowball_version}"
    keyword_truth, vector_truth = load_truth(truth_path, workload, truth_key(workload, identity), analyser.tokens, exact)
    queries = {"keyword": len(workload.keyword_queries), "vector": len(workload.vector_queries)}
    text_oracle: TextOracle | None = None
    checks: list[OutputCheck] = []
    for path in outputs:
        runner = parse_runner_answers(read_json(path), path.name, queries)
        check = OutputCheck(path.name, runner.engine, runner.workload, runner.threads)
        if runner.workload == "keyword":
            check_keyword(check, runner.answers["keyword"], keyword_truth, workload.settings["limit"])
        else:
            if text_oracle is None:
                text_oracle = TextOracle(workload.vector_documents, analyser.tokens)
            check_vector(check, runner, workload, exact, vector_truth)
            check_hybrid(check, runner, workload, text_oracle, vector_truth)
        checks.append(check)
    comparisons = recall_comparisons(checks)
    failures = [failure for check in checks for failure in check.failures]
    failures += [
        f"{comparison.first} and {comparison.second} differ in mean {comparison.metric} by "
        f"{comparison.mean_difference:+.4f}, beyond the {comparison.bound:.4f} that graph randomness explains"
        for comparison in comparisons
        if not comparison.passed
    ]
    failures += score_disagreements(checks)
    return {
        "passed": not failures and all(check.failure_count == 0 for check in checks),
        "failures": failures,
        "outputs": [output_summary(check) for check in checks],
        "crossEngine": [comparison.as_json() for comparison in comparisons],
        "oracle": {
            "python": platform.python_version(),
            "snowballstemmer": module.snowball_version,
            "englishRevision": PINNED_ENGLISH_REVISION,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(prog="engine_languages_oracle")
    parser.add_argument("--workload", type=Path, required=True)
    parser.add_argument("--truth", type=Path, required=True)
    parser.add_argument("--verdict", type=Path, required=True)
    parser.add_argument("outputs", type=Path, nargs="+")
    arguments = parser.parse_args()
    try:
        verdict = check_outputs(load_workload(arguments.workload), arguments.truth, arguments.outputs)
    except (UnusableInput, ModuleError, KeyError, TypeError, ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return EXIT_UNUSABLE
    partial = arguments.verdict.with_name(f"{arguments.verdict.name}.partial")
    partial.write_text(json.dumps(verdict, indent=2), "utf-8")
    partial.replace(arguments.verdict)
    for failure in verdict["failures"]:
        print(failure, file=sys.stderr)
    checked = len(verdict["outputs"])
    print(f"{checked} runner outputs checked; {'every check passed' if verdict['passed'] else 'some checks failed'}")
    return EXIT_PASSED if verdict["passed"] else EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
