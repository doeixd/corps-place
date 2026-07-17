# V9.5 parity report

Generated: 2026-07-17T11:05:04.256Z

This treatment report applies the Milestone 1 tolerances, with the documented pooled two-seed policy for the nine-row sparse-history stability guardrail.

| Candidate | Seed | Val recap | Val total | Cal coverage | Established total | Sparse total | Zero total | Composite | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| fixed42 | 42 | 0.3607 | 0.9818 | 0.8258 | 0.8570 | 2.2660 | 3.2940 | 0.4989 | CORE PASS (sparse pooled) |
| fixed43 | 43 | 0.3483 | 0.9500 | 0.8158 | 0.8616 | 1.6888 | 2.1216 | 0.5006 | PASS |

Two-seed recap mean/range: 0.3545/0.0124

Two-seed total mean/range: 0.9659/0.0318

Sparse-history policy: pooled; mean/range: 1.9774/0.5772

Overall Milestone 1 result: **PASS**

A passing reconstruction gate establishes V9.5 trainer parity. It does not establish that an improvement candidate beats final2; that requires the frozen terminal checkpoint comparison.
