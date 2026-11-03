# discovery: concepts

- **Import job**: one uploaded CSV, from its validation to its import. The upload writes it as `validated` (at least one valid row) or `invalid` (none). The run moves a `validated` one to `running`, from its `startedAt`, then `done` or `failed`; it runs once.
- **Run**: the import of a validated job's valid rows, a person and a lead each, through contacts, by the worker's workflow `discovery_import_run`, in chunks of 500 rows, each committed on its own with one `discovery.people_imported`. A retried attempt goes on after the last committed chunk. A failed run keeps the chunks before the one that failed.
- **Stuck job**: a job `running` for more than ten minutes. The screen says it may be stuck and stops reading it; [runbook.md](runbook.md) "A job left running" says what to do.
- **Counts**: what the run did with every data row, in one bucket each: `created`, `updated`, `skippedDuplicate`, `skippedErased`, `errors`.
- **Validation report**: the counts of a file's data rows (all, valid, in error) and its first 100 row errors in row order, each a record number and a code. It never holds a cell.
- **Row codes**: `url_invalid`, `url_not_linkedin`, `duplicate_in_file` and `person_erased`. They are lines of the report, not request errors. A row gets the first code that applies; a duplicate is checked against the earlier valid rows.
- **File codes**: `import_unsupported_type`, `import_bad_encoding`, `import_missing_column`, `import_too_many_rows` and `import_too_large` refuse the whole file. A refused file is not stored and creates no job.
- **Profile URL**: contacts' rule, `normalizeLinkedinUrl`: `linkedin.com/in/<slug>` on `linkedin.com` or `www.linkedin.com`, with or without its scheme, compared once normalized: lowercased, without `www.`, a query, a fragment or the one trailing slash. A country or mobile host is refused for now.
- **Erased person**: a person erased from the workspace, of whom contacts keeps a hash only. A row with that profile is `person_erased`. A rejected candidate's hash marks no row.
