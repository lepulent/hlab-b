---
id: CONSTITUTION
kind: constitution
assurance: draft
valid_from: null
---

# Constitution

Each principle is a negative constraint that names the permitted alternative, the check that enforces it, its tier and the app status from which it binds. Below its `binds_from` status a violation is a note; at or above it the tier decides: constitutional blocks, governing mints a debt entry, advisory notes.

### C-1 No data shape without a migration path once real records exist

- tier: constitutional
- binds_from: beta
- check: canon-check/record-shape (pending)
- alternative: version the record type; add fields as optional

### C-2 Personal data never leaves its declared store

- tier: constitutional
- binds_from: beta
- check: policy/manifest-classification (pending)
- alternative: derive an anonymised aggregate in the analysis store

### C-3 Every AWS resource is tagged from birth

- tier: governing
- binds_from: prototyping
- check: policy/tags-present (pending)
- alternative: none; untagged resources are refused by the policy test
