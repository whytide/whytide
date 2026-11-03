---
---

providers: the Unipile adapter's send calls

Upgrade: set `UNIPILE_CURSOR_SECRET` (at least 32 characters, `openssl rand -hex 32`) before restarting with `PROVIDER_LINKEDIN=unipile`; the adapter refuses to start without it. A signal run in flight at the upgrade holds an unsigned cursor and fails once.
