# Benchmark writeup generator

`BENCHMARKS.md` at the repository root compares Narsil against production search
servers and against in-process libraries. The prose is written by hand, but every
number, table, and figure is generated from recorded runs, so the page cannot
quietly fall out of step with the results.

## How it works

`generate.py` reads the latest run of each suite, the server suite under
`benchmarks/server/results/runs/` and the in-process suite under
`benchmarks/in-process/results/runs/`, and fills the regions of `BENCHMARKS.md`
marked by `<!-- BENCH:<id> START -->` and `<!-- BENCH:<id> END -->` comments. The
newest run wins, because each run directory is named with a UTC timestamp. Where
the server run directory holds a `comparison-best-config.json`, the generator also fills
the two blocks that show each engine under its recommended production settings.
Everything outside those markers stays exactly as written.

`charts.py` draws the figures the page embeds into a `charts/` directory inside
each run's own directory, so the figures drawn from a run's numbers stay beside
them, and each figure prints the run id it came from. It draws five kinds of chart:

- bar charts of ranking quality and peak throughput with confidence intervals,
- line charts across the concurrency sweep, showing throughput, server p99 under
  load, and the engine's busy cores,
- a latency profile from p50 to the maximum at each engine's peak,
- throughput against recall across the search-effort sweep, and
- the embedded engines across corpus size.

The script leaves out a chart whose data the harness did not record, and the page
leaves out that figure with it.

Rewriting the page needs only the Python standard library. Drawing the charts needs
matplotlib, pinned in the `charts` extra of `benchmarks/server/pyproject.toml`.
`generate.py --check` imports it only where it is installed, so the page check runs
without it and the figure comparison joins in once it is present.

## Commands

Run these from the repository root after a benchmark run:

```bash
python3 -m pip install -e 'benchmarks/server[charts]'   # once, for the chart renderer
python3 benchmarks/writeup/charts.py             # draw every figure into the runs' charts/ directories
python3 benchmarks/writeup/generate.py           # rewrite BENCHMARKS.md from the latest runs
python3 benchmarks/writeup/generate.py --check   # exit non-zero if the page or a figure is out of date
```

Continuous integration runs the check on every push and pull request with
matplotlib installed, so a page that no longer matches the committed runs, a figure
the page embeds that is missing, or a committed figure that differs from a fresh
drawing of its run fails the build. Without matplotlib the check verifies the page
and the presence of every figure alone.

## Publishing a run

Publishing new numbers takes four steps: run a suite, draw the charts, regenerate
the page, and commit the run directory together with its charts and `BENCHMARKS.md`.
The check reads committed runs, so the run directory that backs the page has to be
committed alongside it.
