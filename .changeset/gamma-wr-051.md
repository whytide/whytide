---
"@whytide/signals": patch
"@whytide/worker": patch
"@whytide/ai": patch
"@whytide/db": patch
---

gamma-wr-051: each company a research run reads and judges costs one `signals.researched_company` credit (`SIGNALS_CREDITS_PER_RESEARCHED_COMPANY`, 1 by default), reserved before its site is read and committed with its verdict, a refused credit ending the run `insufficient_credits`; and the research plan's prompt version 2 reads how many companies each earlier query and source type led to, by verdict, and the towns of the fitting ones
