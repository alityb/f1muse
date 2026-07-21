# Championship Scoring Rules

`src/scoring/rules.ts` is a versioned, cited registry for F1Muse's per-session
scoring explanations and validation. It is not a championship-total calculator.
Season totals remain authoritative only when read from
`season_driver_standing`; race-result sums are forbidden because sprint points,
classification corrections, and other official adjustments may be absent.

## Supported Rules

| Seasons | Standard race points (P1-P10) | Fastest lap | Sprint points | FIA source |
|---|---|---|---|---|
| 2021 | 25, 18, 15, 12, 10, 8, 6, 4, 2, 1 | 1 point, only if classified in P10 or higher | 3, 2, 1 | [2021 Issue 13, Articles 6.4-6.5](https://www.fia.com/sites/default/files/2021_formula_1_sporting_regulations_-_iss_13_-_2021-12-08.pdf) |
| 2022-2024 | 25, 18, 15, 12, 10, 8, 6, 4, 2, 1 | 1 point, only if classified in P10 or higher | 8, 7, 6, 5, 4, 3, 2, 1 | [2024 Issue 7, Articles 6.4-6.5](https://www.fia.com/sites/default/files/fia_2024_formula_1_sporting_regulations_-_issue_7_-_2024-07-31.pdf) |
| 2025-2026 | 25, 18, 15, 12, 10, 8, 6, 4, 2, 1 | No bonus | 8, 7, 6, 5, 4, 3, 2, 1 | [2025 Issue 5, Articles 6.4-6.5](https://www.fia.com/system/files/documents/fia_2025_formula_1_sporting_regulations_-_issue_5_-_2025-04-30.pdf) |

The FIA's [Formula One regulations archive](https://www.fia.com/regulation/category/110)
is the discovery index for the cited documents.

## Boundaries

`resolveChampionshipScoringRules` returns `unsupported` for every season before
2021 and after 2026. Historical schedules, special half-point races, and any
future rule change must be added only with an authoritative FIA citation and
explicit inclusive season bounds. The registry intentionally does not guess.

The committed `tests/fixtures/scoring-rules-golden.json` is emitted by
`npm run golden:snapshot:scoring-rules`, and `tests/scoring-rules.test.ts`
checks all supported seasons, every transition, both unsupported boundaries,
the exact schedules, fastest-lap eligibility/removal, and the totals-authority
invariant.
