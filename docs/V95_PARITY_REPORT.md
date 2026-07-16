# V9.5 parity report

Generated: 2026-07-16T14:36:59.361Z

This report applies the predeclared Milestone 1 tolerances from `V10_MODEL_PLAN.md`.

| Candidate | Seed | Val recap | Val total | Cal coverage | Established total | Sparse total | Zero total | Composite | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| seed42 | 42 | 0.3560 | 0.8892 | 0.8261 | 0.7931 | 2.4336 | 1.8413 | 0.4929 | FAIL (sparse_history) |
| seed43 | 43 | 0.3504 | 0.9436 | 0.8209 | 0.8497 | 2.2573 | 2.3394 | 0.5002 | FAIL (sparse_history) |

Two-seed recap mean/range: 0.3532/0.0056

Two-seed total mean/range: 0.9164/0.0544

Overall Milestone 1 result: **FAIL**

A passing reconstruction gate establishes V9.5 trainer parity. It does not establish that an improvement candidate beats final2; that requires the frozen terminal checkpoint comparison.
