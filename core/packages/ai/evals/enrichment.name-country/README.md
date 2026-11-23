# enrichment.name-country

The country namer's evals (gamma-en-075; [the agent's README](../../../../modules/enrichment/agents/name-country/README.md)): 30 synthetic locations, none a real person's.

- **Clear** (16): regions and metro areas the place list cannot read, such as "San Francisco Bay Area", "Greater Toronto Area", "Île-de-France" and "Ruhr Region", and one retried after a three-letter code (`AUT`), which the gate refuses.
- **Ambiguous** (5): "Cambridge", "Georgia", "Victoria", "Punjab", "Limburg".
- **No place** (4): "Remote", "Mars", "Worldwide", "EMEA".
- **Fail safe** (4): three injections in the location, and an answer invalid twice (plain text, then a three-letter code), which ends `ai_failed`.

Checks: `country` 0.9 (the expected code, sure, or null), `no_guess` 1 (an ambiguous text is null or not sure), `fails_safe` 1. On the fake, each case is scripted with what a good model answers; a live run (`EVAL_LIVE=1 pnpm -F ai eval enrichment.name-country`, by hand, never in the pipeline) measures the model.
