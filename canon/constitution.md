---
id: CONSTITUTION
kind: constitution
assurance: draft
valid_from: null
---

# Constitution

Each principle is a negative constraint that names the permitted alternative, the check that enforces it and its tier. The tier says who can clear a violation — advisory an agent, governing the owner, constitutional only an amendment — and the app's `stage` in `harness.json` says whether an uncleared one stops a seal now. A constitutional violation blocks at every stage; a governing one is carried as recorded debt through sandbox and alpha and blocks from beta; an advisory one is always debt. A check marked `(pending)` has no implementation yet and its rule reads as unenforced — never as satisfied.

### C-1 No data shape without a migration path once real records exist

- tier: constitutional
- check: canon-check/record-shape (pending)
- alternative: version the record type; add fields as optional

### C-2 Personal data never leaves its declared store

- tier: constitutional
- check: policy/manifest-classification (pending)
- alternative: derive an anonymised aggregate in the analysis store

### C-3 Every AWS resource is tagged from birth

- tier: governing
- check: policy/tags-present
- alternative: none; untagged resources are refused by the policy test
