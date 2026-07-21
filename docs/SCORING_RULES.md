# Championship Scoring Rules

`src/scoring/rules.ts` is an immutable, versioned registry of **Drivers'
Championship race-result schedules**. It is not an official standings calculator.
`season_driver_standing` is the only authority for a season total: do not sum
result rows, apply dropped-score rules, or infer a total from this registry.

## Sources

Every registry interval carries its citation in `authority`. The historical
1950-2020 intervals use [StatsF1's points-system history](https://www.statsf1.com/en/statistiques/pilote/point/reglement.aspx), a specialist historical database, because the FIA's public regulation archive does not provide a complete digitised pre-modern rule set. Modern intervals use FIA sporting regulations: [2021 Issue 13](https://www.fia.com/sites/default/files/2021_formula_1_sporting_regulations_-_iss_13_-_2021-12-08.pdf), [2024 Issue 7](https://www.fia.com/sites/default/files/fia_2024_formula_1_sporting_regulations_-_issue_7_-_2024-07-31.pdf), [2025 Issue 5](https://www.fia.com/system/files/documents/fia_2025_formula_1_sporting_regulations_-_issue_5_-_2025-04-30.pdf), and [2026 Section B Issue 7](https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_b_sporting_-_iss_07_-_2026-06-25.pdf). The FIA [regulations archive](https://www.fia.com/regulation/category/110) is the primary-source index.

## Rule Intervals

| Seasons | Race P1 onward | Fastest lap | Championship-counting rule |
|---|---|---|---|
| 1950-1953 | 8, 6, 4, 3, 2 | 1, shared if tied | best 4 |
| 1954-1957 | 8, 6, 4, 3, 2 | 1, shared if tied | best 5 |
| 1958 | 8, 6, 4, 3, 2 | 1, shared if tied | best 6 |
| 1959 | 8, 6, 4, 3, 2 | 1, shared if tied | best 5 |
| 1960 | 8, 6, 4, 3, 2, 1 | none | best 6 |
| 1961-1966 | 9, 6, 4, 3, 2, 1 | none | interval-specific best results |
| 1967-1980 | 9, 6, 4, 3, 2, 1 | none | split-season best results |
| 1981-1990 | 9, 6, 4, 3, 2, 1 | none | all results |
| 1991-2002 | 10, 6, 4, 3, 2, 1 | none | all results |
| 2003-2009 | 10, 8, 6, 5, 4, 3, 2, 1 | none | all results |
| 2010-2018 | 25, 18, 15, 12, 10, 8, 6, 4, 2, 1 | none | all results |
| 2019-2024 | same P1-P10 | 1 for top-10 finisher | all results |
| 2025-2026 | same P1-P10 | none | all results |

The exact annual dropped-score partition is data, not prose, in each registry
entry. 1950-1957 shared drives split position points equally; tied fastest laps
also split the one-point bonus. Shared drives became ineligible from 1958.

## Exceptions And Boundaries

- 2014 has `race_multiplier: 2`: it records the special final-race rule only. It must not be applied without identifying the official season-final event.
- Sprints: 2021 P1-P3 = 3-2-1; 2022-2026 P1-P8 = 8-7-6-5-4-3-2-1. No sprint means `sprint_points: []`.
- Shortened races are represented as policy descriptions, not a per-event calculator. 1975-76, 1980-2021, and 2022-2026 have distinct regimes; intervals without a cited general regime are explicitly `unknown`. Always use the FIA final classification for an actual event.
- The 2021 Belgian GP and other event-specific interruptions, classification amendments, ineligible entries, and constructor rules are intentionally not derived here.
- The registry supports inclusive seasons 1950-2026. Earlier and later seasons return explicit `unsupported` resolutions.

`tests/fixtures/scoring-rules-golden.json` is emitted by
`npm run golden:snapshot:scoring-rules`; tests assert coverage, source presence,
historical transitions, shared-point behavior, dropped-score representation,
modern exceptions, and the standings-authority boundary.
