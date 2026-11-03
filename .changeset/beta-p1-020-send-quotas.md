---
---

linkedin: send quotas and the hard maximums

Upgrade: `LINKEDIN_DAILY_READ_CAP_MAX` now takes 1 to 100 and defaults to 100 (it took up to 1,000 and defaulted to 250). An existing `.env` above 100, `.env.local` copies of the old example included, must come down to 100 before the upgrade, or the start fails with `config_invalid`. The migration `linkedin_send_quotas` brings every account's daily read cap above 100 down to 100.
