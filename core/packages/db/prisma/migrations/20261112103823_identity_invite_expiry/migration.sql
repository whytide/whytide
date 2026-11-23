-- AlterTable
ALTER TABLE "invites" ADD COLUMN     "expires_at" TIMESTAMPTZ NOT NULL DEFAULT (now() + '7 days'::interval),
ADD COLUMN     "mailed_at" TIMESTAMPTZ,
ADD COLUMN     "revoked_at" TIMESTAMPTZ,
ADD COLUMN     "revoked_by" TEXT;

-- Hand-written (prisma/schema/identity.prisma points here), for invites by email (gamma-p6-020;
-- core/modules/identity/docs/data.md): an invite made before this migration expires
-- INVITE_TTL_DAYS (7) after it was made, as one made after it; the default only serves a previous
-- release's createInvite, since the current one always sets expires_at. Revoked at and by together
-- or neither, and never both accepted and revoked.
UPDATE "invites" SET "expires_at" = "created_at" + '7 days'::interval;
ALTER TABLE "invites" ADD CONSTRAINT "invites_revoked_together"
  CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL));
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_or_revoked"
  CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);
