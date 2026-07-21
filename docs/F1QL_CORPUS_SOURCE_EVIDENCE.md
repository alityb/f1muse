# F1QL Corpus Source Evidence

## Classification

The complete committed 100-case corpus is classified by `productionCorpusAudit`:

| Disposition | Count | Meaning |
| --- | ---: | --- |
| Fixture-only | 41 | 15 deliberate rejections and 26 source-dependent pace cases; never externally factual. |
| Production-runnable structural | 59 | Canonical-view shape is runnable, but synthetic fixture rows are not production facts. |
| Authoritative factual | 0 | No local fixture case is an external fact. |

The separate bounded production manifest contains 3 structural cases and 23
authoritative factual cases. It is not a relabeling of fixture output.

## Research Method And Cost

On 2026-07-21, Exa Search was called with `EXA_API` sourced only for each shell
command. Seven neural searches were made, each capped at three results and 700
or fewer extracted characters per result. No API key, request ID, or API
response metadata is committed. Exa returned a $0.007 search charge for each
request: **7 requests, $0.049 total**. Queries were bounded to FIA or Formula 1
domains and sought only the source categories below.

## Cited Factual Manifest

| Season | Query type | Fact scope | Official source |
| --- | --- | --- | --- |
| 1950 | Event metadata | British GP date and identity | [FIA Records Lists (1950-1959)](https://www.fia.com/records-lists-1950-1959) |
| 2014 | Race classification | Abu Dhabi winner and double final-race points | [FIA report](https://www.fia.com/news/hamilton-wins-abu-dhabi-take-2014-f1-title) |
| 2019 | Race classification | Australia winner and fastest-lap point | [FIA Document 31](https://www.fia.com/sites/default/files/doc_31_-_2019_australian_grand_prix_-_final_race_classification.pdf) |
| 2021 | Race classification | Belgium abbreviated-race classification | [FIA Document 43](https://www.fia.com/sites/default/files/doc_43_-_2021_belgian_grand_prix_-_final_race_classification.pdf) |
| 2022 | Race classification | Austria winner under the 2022 scoring interval | [FIA Document 78](https://www.fia.com/sites/default/files/doc_78_-_2022_austrian_grand_prix_-_final_race_classification_0.pdf) |
| 2024 | Race classification and metadata | Bahrain winner, points, date, event identity | [FIA 2024 championship documents](https://www.fia.com/documents/season/season-2024-2043/championships/formula-1-world-championship-14) |
| 2025 | Standings | Final Drivers' Championship standing | [FIA Abu Dhabi Championship Points, Document 56](https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf) |
| 2025 | Qualifying classification and metadata | Australia pole and event identity | [Formula 1 report](https://www.formula1.com/en/latest/article/norris-storms-to-pole-position-for-the-australian-grand-prix-ahead-of.7xW094Sd0b5e2qHIvAaf3s) |
| 2025 | Standings | Final P2, P3, and zero-point driver standings | [FIA Abu Dhabi Championship Points, Document 56](https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf) |
| 2025 | Race classification | Australia P2/P3 and DNF | [FIA Australian Final Race Classification](https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_race_classification.pdf) |
| 2025 | Qualifying classification | Australia P2 and P3 | [FIA Australian Final Qualifying Classification](https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_qualifying_classification.pdf) |

`scripts/f1ql-production-corpus-manifest.ts` contains exact programs, expected
field subsets, scoring-rule IDs, and source URLs. The runner validates each
program, uses a read-only transaction with a five-second local timeout, and
compares only these expected fields.

## Final Season Standings Checks

Each final-total check queries only `f1ql.driver_standings`, the F1QL projection
of `season_driver_standing`. It uses the recorded season-standing value and
does not derive a championship total from race classifications.

| Season | Champion | Final points | FIA final-standing authority |
| --- | --- | ---: | --- |
| 2014 | Lewis Hamilton | 384 | [2014 Classifications](https://www.fia.com/events/fia-formula-one-world-championship/season-2014/2014-classifications) |
| 2019 | Lewis Hamilton | 413 | [2019 Classifications](https://www.fia.com/events/fia-formula-one-world-championship/season-2019/2019-classifications) |
| 2021 | Max Verstappen | 395.5 | [Abu Dhabi Championship Points, Doc. 60](https://www.fia.com/sites/default/files/decision-document/2021%20Abu%20Dhabi%20Grand%20Prix%20-%20Championship%20Points.pdf) |
| 2022 | Max Verstappen | 454 | [Abu Dhabi Championship Points, Doc. 38](https://www.fia.com/sites/default/files/decision-document/2022%20Abu%20Dhabi%20Grand%20Prix%20-%20Championship%20Points.pdf) |
| 2024 | Max Verstappen | 437 | [Abu Dhabi Championship Points, Doc. 58](https://www.fia.com/sites/default/files/decision-document/2024%20Abu%20Dhabi%20Grand%20Prix%20-%20Championship%20Points.pdf) |
| 2025 | Lando Norris | 423 | [Abu Dhabi Championship Points, Doc. 56](https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf) |

The same FIA Document 56 establishes the additional 2025 recorded standings:
Max Verstappen P2 on 421 points, Oscar Piastri P3 on 410 points, and Franco
Colapinto P20 on zero points. All four 2025 totals query only
`f1ql.driver_standings` through recorded `MAX` measures; none sums race rows.

## Limits

- FIA's publicly indexed historical material is not a complete digitised
  classification archive. The 1950 case is deliberately metadata-only.
- The 2022 FIA sprint classification was researched but is not runnable: F1QL
  currently exposes a race-only event-classification source, not a sprint
  session source.
- A source URL establishes the authority for a manifest expectation; it does
  not prove that production has ingested the season. Missing views skip, and a
  mismatch fails without changing the expected fact.
- The guarded 2026-07-21 production run found the FIA-authoritative 2025
  Australia DNS (Isack Hadjar) and Las Vegas DSQ (Lando Norris) absent from
  `f1ql.event_classification`; they are excluded from the manifest until the
  canonical source supports them. The supported Australia DNF row records
  `points: null`, so its factual assertion deliberately covers driver, null
  position, and normalized `dnf` status only.
- Synthetic fixture rows, all fixture pace results, and deliberate rejection
  cases remain excluded from external factual claims.
