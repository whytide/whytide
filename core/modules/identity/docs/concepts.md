# identity: concepts

- **Invite**: an email let into one workspace with a role, `Owner` in alpha, until its first sign-in accepts it; one per workspace and email. It does not expire in alpha.
- **Invite-only sign-in**: an email may sign in when it has an invite not accepted yet or its user has a membership (`allowSignIn`); anyone else is refused before a link is mailed.
- **First sign-in**: following a link for an invited email creates the user and accepts the email's invites, a membership for each, with the invite's role.
- **The guard**: on every workspace route, the api host asks `workspaceResolver` for the caller's membership of the URL's workspace, by id or slug; none is 403 `forbidden`, before any module code runs.
- **Email**: trimmed, lowercased, 254 characters at most, as tenancy's users and the authentication port keep it.
