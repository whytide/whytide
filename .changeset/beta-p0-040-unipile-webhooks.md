---
---

providers: Unipile's webhooks and account pairing

Upgrade: register the `messaging` and `users` webhooks, and register the `account_status` one again with every event (the commands in `core/packages/providers/linkedin/unipile/README.md` "Webhooks"). A hosted link made before the upgrade has no pairing token: its notify is refused, and the user connects again.
