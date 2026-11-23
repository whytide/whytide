# icp: concepts

- **ICP**: who the workspace sells to, edited in place, with a version.
- **Audience**: one such profile with its own six criteria and version; a workspace holds up to `ICP_MAX_AUDIENCES_PER_WORKSPACE`, 10 unset (gamma-p3-020; README "Settings"). Its **default** is the workspace's ICP: qualification's scoring, the ICP's own routes, the draft's without `?icpId=` and `pnpm icp:draft` without `--icp` act on it. `created_by` records the member who created an audience, or `system` for a service's first read.
- **Hard filters**: the targeting fields code compares before any AI call, so a miss costs no credit and is never scored (alpha-p6-010: titles, countries, company sizes). Free text such as industries is judged by the criteria instead, until a taxonomy arrives.
- **Criteria**: the six things the assessment agent gives a verdict on for a person past the hard filters (`met`, `partially_met`, `not_met`, `unknown`): `title_function`, `seniority`, `company_size`, `industry`, `location` and `must_haves`, the must-haves text. Code computes the fit score from the verdicts and the weights (alpha-p6-030); a must criterion at `not_met` caps the fit at 40; a disabled one does not count.
- **Weights**: whole numbers from 0 to 100 that sum to 100 over the six; the scorer renormalizes over the enabled ones.
- **Must-haves and disqualifiers**: two texts of 1,000 characters at most, which the model reads as data in a delimited block, never as instructions.
- **Version**: 1 when an audience is created, one more with every targeting change, any field but the name; `icp.audience_updated` carries it, and `icp.updated` the default's, so leads scored with an older one can be re-scored (alpha-p6-040).
