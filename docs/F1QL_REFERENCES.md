# F1QL References and Claim Status

This document separates background literature from claims that F1Muse has
actually implemented or proved. A citation explains a design lineage; it does
not turn a target architecture into a guarantee.

## Data Sources

- F1DB: https://github.com/f1db/f1db
- FastF1 documentation: https://docs.fastf1.dev/
- Jolpica F1 API: https://api.jolpi.ca/

## Programming Language and Database Background

| Topic | Reference | F1Muse status |
|---|---|---|
| Conjunctive-query containment/equivalence | A. Chandra, P. Merlin, *Optimal Implementation of Conjunctive Queries in Relational Databases*, STOC 1977 | Background only; F1QL normalization is not implemented |
| Rewrite-system confluence | M. H. A. Newman, *On Theories With a Combinatorial Definition of Equivalence*, Annals of Mathematics, 1942 | Background only; no F1QL rewrite proof exists yet |
| Type soundness | A. Wright, M. Felleisen, *A Syntactic Approach to Type Soundness*, Information and Computation, 1994 | Target proof obligation; no F1QL type system exists yet |
| Differential testing | W. M. McKeeman, *Differential Testing for Software*, Digital Technical Journal, 1998 | Planned for compiler/reference interpreter |
| Property-based testing | K. Claessen, J. Hughes, *QuickCheck: A Lightweight Tool for Random Testing of Haskell Programs*, ICFP 2000 | Planned for F1QL programs |
| Data provenance | T. J. Green, G. Karvounarakis, V. Tannen, *Provenance Semirings*, PODS 2007 | Background only; v1 uses AST-derived provenance |
| Parser combinators | G. Hutton, E. Meijer, *Monadic Parser Combinators*, JFP 1998 | Planned Tier-0 grammar direction |
| Differential dataflow | F. McSherry et al., *Differential Dataflow*, CIDR 2013 | Explicitly rejected for v1 fact rebuilds |

## Citation Rules

1. Every formal claim in `docs/architecture.md` must link to this document.
2. Every claim must be labeled `implemented`, `tested`, `proved`, `planned`,
   or `background only`.
3. A production behavior is not independently verified until a source snapshot
   or authoritative upstream reference is stored alongside its golden case.
