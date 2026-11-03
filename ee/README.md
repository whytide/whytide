# ee/

The enterprise edition: the short list of features that are not part of Whytide Core (SSO and SCIM, custom roles, data residency, the audit viewer, the compliance portal). Empty in alpha.

- An enterprise module lives at `ee/modules/<name>` with the same shape as a core module (docs/architecture.md §4.2) and attaches at the extension points.
- `ee/` imports `core/`; `core/` never imports `ee/`. The boundary lint protects the direction, and this folder exists so that it has something to protect. Core images contain no `ee/` code.
