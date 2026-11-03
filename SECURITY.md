# Security

Whytide Core and Whytide Cloud run the same code, so a vulnerability in one is a vulnerability in the other. Please report it privately.

## Report a vulnerability

- Email **security@whytide.com**. Once the project enables them, a confidential issue in the GitLab project works too.
- Never in a public issue, merge request or post. Never test against the hosted service with another customer's workspace or data.
- Include what is affected (Core or Cloud, the version or commit), the steps to reproduce, what an attacker gains, and how to reach you.

## What happens next

- Triage within 2 business days: we confirm the report, rate it and name an owner.
- The fix is made in private. Cloud is patched first (a critical issue within 72 hours, a high one within 7 days), then patch releases for the current and the previous line ship with an advisory, and self-hosters are told ([docs/architecture.md §15](docs/architecture.md#15-security)).
- You are credited in the advisory unless you prefer not to be named.

`security.txt` on the website arrives with the public site. The rules every change follows are in [docs/rules/security.md](docs/rules/security.md).
