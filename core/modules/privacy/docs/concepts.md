# privacy: concepts

- **Erasure**: the deletion of everything a workspace holds about one person, on that person's request, in one tenant run: all of it commits, or nothing does. It is per workspace: the same person in another workspace keeps its rows.
- **Eraser**: a module's function that deletes the person's rows in its own tables, in the caller's run, and returns the rows it deleted by table. Each module erases its own rows; privacy only runs them.
- **Dependency order**: a module whose rows name another module's rows (a draft and a snapshot name their decision records) is erased first, so no erased row is left pointing at nothing and no row is read after its reference is gone. Contacts goes last, since every other row names the person.
- **Erased hash**: the salted hash of the person's normalized URL, and of each provider id, that contacts keeps with kind `erased`. An import or a signal run that meets it skips the person, and no command adds the person again. It is the only trace of the person left, and it is not reversible without the salt.
- **Erasure log**: one row per committed erasure: the URL's erased hash, when it was asked and done, the counts by module and table, and the operator. It proves the erasure without naming the person.
- **Operator**: the person who runs the command, named with `--operator`; never the person erased.
- **Dry run**: the erasure with every step, rolled back at the end on purpose, to see the counts before the real one.
