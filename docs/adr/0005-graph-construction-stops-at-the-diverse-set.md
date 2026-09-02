---
status: accepted
---

# The graph builder stops at the diverse set and inserts into the existing graph

The graph builder filled every neighbour list back up to its cap with the candidates the diversity rule had rejected. It also rebuilt the whole graph from every vector each time the buffer crossed its threshold. A benchmark import therefore built the graph twice, and three quarters of its distance computations went to re-pruning full lists. We have decided that neighbour selection stops at the diverse set, as hnswlib, Lucene, and Qdrant do, and that the builder inserts new vectors into the existing graph one at a time. Optimise adopts the graph it finds and rebuilds it only once callers have removed more than a fifth of the vectors. Both choices stay inside the spec, which fixes recall floors and no construction rule, while matching how every engine in the comparison builds.

## Considered options

With the backfill kept, recall at search effort 64 was 0.993 against 0.990 without it, and at effort 16 it was 0.954 against 0.926. The build with it was 2.5 times slower on 5,183 vectors of 384 dimensions. Giving a new vector M links at the bottom layer in place of 2M, as hnswlib does, built 2.1 times faster with recall at effort 64 unchanged. However, Lucene and Qdrant keep 2M, and since recall at effort 16 fell to 0.947 the links stay at 2M.

## Consequences

A graph built before this decision stays valid, because the spec's contract is recall and a graph that mixes the two rules still meets it. The benchmark's recall sweep may settle on a higher search effort for the same recall target, which is the trade every competitor already made.
