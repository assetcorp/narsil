# Benchmark writeup generator

`BENCHMARKS.md` at the repository root compares Narsil against production search
servers and against in-process libraries. The prose is written by hand, but every
number, table, and chart is generated from recorded runs, so the page cannot
quietly fall out of step with the results.

## How it works

`generate.py` reads the latest run of each suite, the server suite under
`benchmarks/server/results/runs/` and the in-process suite under
`benchmarks/in-process/results/runs/`, and fills the regions of `BENCHMARKS.md`
marked by `<!-- BENCH:<id> START -->` and `<!-- BENCH:<id> END -->` comments. The
newest run wins, because each run directory is named with a UTC timestamp.
Everything outside those markers stays exactly as written.

The tool depends only on the Python standard library and reads each run's
committed JSON, so it produces the same page on any machine.

## Commands

Run these from the repository root after a benchmark run:

```bash
python3 benchmarks/writeup/generate.py          # rewrite BENCHMARKS.md from the latest runs
python3 benchmarks/writeup/generate.py --check   # exit non-zero if the page is out of date
```

Continuous integration runs the check on every push and pull request, so a page
that no longer matches the committed runs fails the build.

## Publishing a run

Publishing new numbers takes three steps: run a suite, regenerate the page, and
commit the run directory together with `BENCHMARKS.md`. The check reads committed
runs, so the run directory that backs the page has to be committed alongside it.
