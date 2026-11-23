-- AlterTable
ALTER TABLE "persons" ALTER COLUMN "linkedin_url" DROP NOT NULL;

-- Hand-written comment (gamma-rf-050; contacts' docs/data.md): a person is known by their LinkedIn
-- profile, by the hashes of their email addresses (person_email_hashes), or by both, and always by one
-- of them, which contacts' upsertPersonFromSource keeps: it creates a person without a profile in the
-- run that records their address's hash. Expand only: the unique key (workspace_id, linkedin_url)
-- stays, and holds any number of persons without one, since Postgres never finds two NULLs equal; the
-- CHECK persons_linkedin_url_lowercase stays, and a NULL passes it.
