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

The root `README.md` and `packages/ts/README.md` each hold one generated region,
`BENCH:headline`, which quotes the ranking score and the peak throughput from the
same server run. The generator fills both, so a figure in a README changes with the
run that it came from. `headline_section.py` names the two files, and it gives the
package README the benchmark page's address on GitHub, because npm publishes that
file away from the repository.

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

## Narsil's two servers

The server suite can measure Narsil's TypeScript server under the engine id
`narsil` and its Rust server under `narsil-rust`. While a run holds results for
the TypeScript server alone, the page calls it Narsil. Once a run holds results
for both servers, every server table and chart gives each server a separate row,
labelled Narsil TypeScript and Narsil Rust, and a dataset that the run measured
with only one of them lists the other as not measured yet. The README headline
quotes the Rust server's peak in a separate sentence, and it never treats one
Narsil server as a rival of the other.

## Previewing the page

Before a new benchmark run, you can render the page into one HTML file and review
its layout first:

```bash
python3 -m pip install -e 'benchmarks/server[preview]'
python3 benchmarks/writeup/preview.py --output /tmp/benchmarks-preview.html
```

The preview reads the newest recorded runs and gives both Narsil servers a row in
every server table and chart, so a server that no run has measured shows as not
measured yet, with no figure. The README headline appears above the page. The
script inlines every figure and points every relative link at the repository on
GitHub, so the file opens on any machine without the checkout. It writes the
output file alone, which leaves the committed page and figures unchanged.

Rewriting the page needs only the Python standard library. Drawing the charts needs
matplotlib, pinned in the `charts` extra of `benchmarks/server/pyproject.toml`.
`generate.py --check` imports it only where it is installed, so the page check runs
without it and the figure comparison joins in once it is present.

## Commands

Run these from the repository root after a benchmark run:

```bash
python3 -m pip install -e 'benchmarks/server[charts]'   # once, for the chart renderer
python3 benchmarks/writeup/charts.py             # draw every figure into the runs' charts/ directories
python3 benchmarks/writeup/generate.py           # rewrite BENCHMARKS.md and both READMEs from the latest runs
python3 benchmarks/writeup/generate.py --check   # exit non-zero if a page or a figure is out of date
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
