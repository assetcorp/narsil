# SciFact

The data files in this directory are derived from SciFact, a scientific
claim verification dataset created by the Allen Institute for AI, as
packaged for retrieval evaluation by the BEIR benchmark.

- **Creators**: David Wadden, Shanchuan Lin, Kyle Lo, Lucy Lu Wang, Madeleine van Zuylen, Arman Cohan, and Hannaneh Hajishirzi (Allen Institute for AI)
- **Source repository**: <https://github.com/allenai/scifact>
- **BEIR packaging**: <https://github.com/beir-cellar/beir>
- **Archive**: <https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip>
- **Archive SHA-256**: 536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165

## Licenses

- The claim queries and relevance judgments are licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- The corpus abstracts are part of the Semantic Scholar
  [S2ORC](https://github.com/allenai/s2orc) dataset and are licensed under
  [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).

## Conversion notes

The JSON files were produced by `packages/ts/scripts/convert-scifact.ts` from the
archive above: document and query IDs were converted from integer strings
to numbers, queries were filtered to the 300 test-split claims that carry
relevance judgments, and the binary judgments were kept unchanged.

## Citation

```bibtex
@inproceedings{Wadden2020FactOF,
  title={Fact or Fiction: Verifying Scientific Claims},
  author={David Wadden and Shanchuan Lin and Kyle Lo and Lucy Lu Wang and Madeleine van Zuylen and Arman Cohan and Hannaneh Hajishirzi},
  booktitle={EMNLP},
  year={2020},
}
```
