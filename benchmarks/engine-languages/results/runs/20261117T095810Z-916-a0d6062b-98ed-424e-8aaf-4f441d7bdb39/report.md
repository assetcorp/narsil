# Narsil in three languages

Run 20261117T095810Z-916-a0d6062b-98ed-424e-8aaf-4f441d7bdb39 on Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical CPUs, 31 GiB), Linux 7.0.0-1017-gcp x64.

- typescript: @delali/narsil 0.4.3, Node.js v24.22.3, C core narsil-core.node sha256 20b9ad575d02e5c75b6221e6577aee5dad7800828754d8d39b59fecdd6a8ef3a
- rust: delali-narsil 0.2.1, rustc 1.99.1 (58cf8f9c3 2026-10-13), cargo build --release
- go: github.com/assetcorp/narsil/packages/go/engine 0.2.2, go version go1.26.11 linux/amd64, go build -trimpath
- C compiler: cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0

Keyword search uses 50,000 fiqa documents and 1,000 queries. Vector and hybrid search use 5,183 scifact documents with 384-dimension Xenova/all-MiniLM-L6-v2 vectors and 300 queries. Rates and memory figures are medians across 3 repetitions. Latency percentiles pool every measured query. The oracle checked the verification answers against the workload.

## Keyword queries

| Engine | Threads | Queries per second, median (range) | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| typescript | 1 | 14,618 (14,279 to 15,021) | 58.8 | 208.3 |
| rust | 1 | 17,045 (16,858 to 17,232) | 48.0 | 194.3 |
| go | 1 | 14,487 (14,189 to 14,584) | 59.6 | 212.6 |
| typescript | 8 | 19,656 (19,301 to 19,714) | 386.0 | 1,012.2 |
| rust | 8 | 78,793 (78,541 to 79,999) | 80.6 | 347.4 |
| go | 8 | 54,502 (54,443 to 55,146) | 112.7 | 808.0 |

## Vector queries

| Engine | Threads | Queries per second, median (range) | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| typescript | 1 | 8,057 (7,885 to 8,112) | 121.6 | 212.5 |
| rust | 1 | 7,911 (7,741 to 7,941) | 116.2 | 151.3 |
| go | 1 | 8,181 (7,965 to 8,330) | 120.3 | 176.3 |
| typescript | 8 | 10,211 (10,126 to 10,545) | 637.0 | 3,574.4 |
| rust | 8 | 39,729 (39,285 to 39,761) | 183.8 | 233.1 |
| go | 8 | 33,242 (32,936 to 33,637) | 197.4 | 1,382.8 |

## Hybrid queries

| Engine | Threads | Queries per second, median (range) | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| typescript | 1 | 4,730 (4,660 to 4,745) | 205.9 | 334.3 |
| rust | 1 | 4,808 (4,673 to 4,837) | 194.2 | 309.5 |
| go | 1 | 5,591 (5,561 to 5,692) | 164.7 | 326.9 |
| typescript | 8 | 6,065 (6,020 to 6,078) | 1,238.3 | 4,341.5 |
| rust | 8 | 24,752 (24,752 to 24,998) | 296.5 | 499.0 |
| go | 8 | 19,987 (19,854 to 20,025) | 326.2 | 2,409.2 |

## Loading and memory

| Engine | Workload | Threads | Documents | Documents per second | Resident MiB | Peak MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| typescript | keyword | 1 | 50,000 | 19,094 | 562.6 | 605.2 |
| rust | keyword | 1 | 50,000 | 24,426 | 216.9 | 216.9 |
| go | keyword | 1 | 50,000 | 15,163 | 192.6 | 354.1 |
| typescript | vector | 1 | 5,183 | 2,958 | 405.6 | 405.6 |
| rust | vector | 1 | 5,183 | 8,657 | 125.4 | 149.6 |
| go | vector | 1 | 5,183 | 3,871 | 92.0 | 187.2 |
| typescript | keyword | 8 | 50,000 | 25,254 | 997.4 | 1,065.6 |
| rust | keyword | 8 | 50,000 | 23,087 | 235.0 | 235.0 |
| go | keyword | 8 | 50,000 | 15,126 | 195.9 | 355.7 |
| typescript | vector | 8 | 5,183 | 4,646 | 712.3 | 727.1 |
| rust | vector | 8 | 5,183 | 7,973 | 161.6 | 161.6 |
| go | vector | 8 | 5,183 | 3,948 | 111.3 | 189.3 |

## Answers checked against the oracle

| Engine | Threads | Recall@10 | Recall@100 | Hybrid recall@10 | Largest vector score error |
| --- | ---: | ---: | ---: | ---: | ---: |
| typescript | 1 | 0.9857 | 0.9715 | 0.9947 | 1.98e-7 |
| rust | 1 | 0.9861 | 0.9716 | 0.9960 | 1.98e-7 |
| go | 1 | 0.9863 | 0.9714 | 0.9947 | 1.98e-7 |
| typescript | 8 | 0.9888 | 0.9727 | 0.9964 | 1.98e-7 |
| rust | 8 | 0.9872 | 0.9722 | 0.9959 | 1.98e-7 |
| go | 8 | 0.9877 | 0.9725 | 0.9963 | 1.98e-7 |

