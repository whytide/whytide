---
"@whytide/enrichment": patch
"@whytide/signals": patch
"@whytide/providers": patch
"@whytide/worker": patch
"@whytide/db": patch
"@whytide/api": patch
---

gamma-wr-070: a picked person whose page printed no key gets their LinkedIn profile by one web search on linkedin.com (the person's and the company's names the only words, code decides the match, nothing fetched from LinkedIn), and each new lead of a research source is asked one email lookup with the trigger `found`, the address a page printed with the person verified first and kept only on a verifier's `valid` (`ENRICHMENT_LOOKUP_AT_FIND`, on by default)
