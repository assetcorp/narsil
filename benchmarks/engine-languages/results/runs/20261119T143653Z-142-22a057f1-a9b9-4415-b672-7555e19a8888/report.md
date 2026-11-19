# Narsil in three languages

Run 20261119T143653Z-142-22a057f1-a9b9-4415-b672-7555e19a8888 on Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical CPUs, 31 GiB), Linux 7.0.0-1017-gcp x64.

- typescript: @delali/narsil 0.4.5, Node.js v24.22.3, C core narsil-core.node sha256 0f415364ce52699c162d26e9c6c16314aabdd63f39668dca35252f6dc4874c97
- rust: delali-narsil 0.2.2, rustc 1.99.1 (58cf8f9c3 2026-10-13), cargo build --release
- go: github.com/assetcorp/narsil/packages/go/engine 0.2.3, go version go1.26.11 linux/amd64, go build -trimpath
- C compiler: cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0

Keyword search uses 50,000 fiqa documents and 1,000 queries. Vector and hybrid search use 5,183 scifact documents with 384-dimension Xenova/all-MiniLM-L6-v2 vectors and 300 queries. Rates and memory figures are medians across 3 repetitions. Latency percentiles pool every measured query. The oracle checked the verification answers against the workload.

## Keyword queries

| Engine | Threads | Queries per second, median (range) | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| typescript | 1 | 14,653 (14,619 to 14,724) | 58.9 | 206.2 |
| rust | 1 | 16,775 (16,768 to 16,820) | 48.9 | 195.0 |
| go | 1 | 14,256 (14,243 to 14,267) | 60.7 | 212.8 |
| typescript | 8 | 20,417 (20,063 to 20,861) | 368.8 | 974.8 |
| rust | 8 | 81,025 (80,229 to 81,510) | 78.1 | 344.4 |
| go | 8 | 55,825 (55,734 to 56,108) | 109.8 | 797.4 |

## Vector queries

| Engine | Threads | Queries per second, median (range) | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| typescript | 1 | 9,050 (8,974 to 9,074) | 107.8 | 192.4 |
| rust | 1 | 9,224 (8,590 to 9,509) | 98.4 | 128.7 |
| go | 1 | 9,625 (9,587 to 9,711) | 101.2 | 148.6 |
| typescript | 8 | 10,968 (10,932 to 11,393) | 595.5 | 3,935.4 |
| rust | 8 | 48,185 (48,174 to 48,584) | 147.6 | 188.3 |
| go | 8 | 39,729 (39,510 to 40,058) | 163.6 | 1,204.5 |

## Hybrid queries

| Engine | Threads | Queries per second, median (range) | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| typescript | 1 | 5,044 (4,891 to 5,094) | 193.3 | 319.5 |
| rust | 1 | 5,329 (5,121 to 5,345) | 174.9 | 286.8 |
| go | 1 | 6,233 (6,045 to 6,259) | 148.9 | 300.6 |
| typescript | 8 | 6,197 (6,164 to 6,247) | 1,209.9 | 4,218.9 |
| rust | 8 | 28,366 (28,262 to 28,376) | 257.2 | 454.9 |
| go | 8 | 23,245 (23,145 to 23,377) | 282.1 | 1,945.8 |

## Loading and memory

| Engine | Workload | Threads | Documents | Documents per second | Resident MiB | Peak MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| typescript | keyword | 1 | 50,000 | 19,115 | 563.0 | 605.8 |
| rust | keyword | 1 | 50,000 | 24,418 | 217.0 | 217.0 |
| go | keyword | 1 | 50,000 | 15,359 | 189.2 | 349.2 |
| typescript | vector | 1 | 5,183 | 3,126 | 405.4 | 405.7 |
| rust | vector | 1 | 5,183 | 8,642 | 127.7 | 148.8 |
| go | vector | 1 | 5,183 | 4,113 | 91.8 | 187.9 |
| typescript | keyword | 8 | 50,000 | 25,194 | 986.7 | 1,073.8 |
| rust | keyword | 8 | 50,000 | 23,880 | 234.3 | 234.3 |
| go | keyword | 8 | 50,000 | 15,794 | 197.6 | 377.9 |
| typescript | vector | 8 | 5,183 | 4,955 | 711.8 | 726.6 |
| rust | vector | 8 | 5,183 | 8,436 | 159.5 | 159.5 |
| go | vector | 8 | 5,183 | 4,094 | 112.1 | 190.1 |

## Answers checked against the oracle

| Engine | Threads | Recall@10 | Recall@100 | Hybrid recall@10 | Largest vector score error |
| --- | ---: | ---: | ---: | ---: | ---: |
| typescript | 1 | 0.9853 | 0.9720 | 0.9946 | 1.98e-7 |
| rust | 1 | 0.9861 | 0.9718 | 0.9950 | 1.98e-7 |
| go | 1 | 0.9863 | 0.9714 | 0.9947 | 1.98e-7 |
| typescript | 8 | 0.9887 | 0.9719 | 0.9966 | 1.98e-7 |
| rust | 8 | 0.9870 | 0.9722 | 0.9953 | 1.98e-7 |
| go | 8 | 0.9892 | 0.9715 | 0.9971 | 1.98e-7 |

