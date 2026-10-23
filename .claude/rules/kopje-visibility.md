---
paths:
  - "packages/kopje/src/domain/audience.ts"
  - "packages/kopje/test/policy-model.ts"
---

Visibility and audience rules live only in `src/domain/audience.ts` (`packages/kopje/docs/visibility.md`). A change to a rule changes `test/policy-model.ts` in the same pull request; a new read or delivery path uses the module instead of its own SQL.
