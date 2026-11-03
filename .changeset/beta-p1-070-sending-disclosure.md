---
---

linkedin: the risk disclosure for sending

Upgrade: set `LINKEDIN_HASH_KEY`, a new secret of 32 characters or more (`openssl rand -base64 32`), and keep it for good; empty, the hosts start but no account can send. The migration `linkedin_sending_disclosure` puts every existing account at disclosure version 1: each owner accepts the disclosure for sending on the LinkedIn screen before the account sends anything.
