# Official Event Mean Metric

Status: local reviewed contract

## Identifier

`official_non_deleted_non_pit_event_mean_v1`

## Question

For exactly two drivers in one completed race event, which driver has the lower
arithmetic mean lap time across all of that driver's eligible official completed
laps?

## Inputs And Eligibility

- One sealed FIA race dataset with complete artifact, identity, fact, and lap
  continuity checks.
- Exactly two distinct canonical drivers from that dataset.
- Every official completed lap retained for each driver.
- Exclude only FIA-deleted lap times and rows explicitly marked `PIT` in the Race
  History Chart.
- Require at least two eligible laps per driver.

The two drivers may have different completed-lap counts, including because of a
retirement. The result reports both completed and eligible counts and does not
pretend that their fuel, tyre, traffic, or race-state exposure was equal.

## Calculation

1. Convert every eligible lap time to integer milliseconds.
2. Sum each driver's eligible milliseconds and divide by that driver's eligible
   lap count.
3. Report each arithmetic mean in seconds rounded to four decimal places.
4. Report the absolute difference rounded to four decimal places.
5. The lower mean is the winner; equal reported means are a tie.

This metric is deliberately distinct from
`official_non_deleted_non_pit_window_median_v1`. A mean and median may select
different drivers for the same laps.

## Interpretation Boundary

Within a single named race event, an unqualified two-driver question using
“faster” or “quicker” means this metric. It never means finishing classification.
Questions about finishing order must use positional wording. Questions requesting
a median must specify an inclusive lap window and use the separate median-window
metric.

Safety-car, weather, traffic, tyre, fuel, strategy, and other race-state effects
remain included. The result is a descriptive comparison of recorded race laps,
not a causal claim about driver or car performance.

## Availability Boundary

Missing sealed event data, either driver, or minimum eligible coverage yields no
result. There is no fallback to classification, fastest lap, legacy FastF1 pace,
zero, or partial data. The operation is locally executable through canonical
F1QL but remains denied by the answer policy and unavailable in production.
