-- A person's phone (gamma-wr-100). Expand only: no row changes and nothing is dropped. A phone is
-- another kind of contact point: it has no verification and no verified date, so both columns accept
-- null, and a CHECK keeps them required for the two email kinds, as strict as before. A new column
-- holds the address of the page a value came from.
ALTER TYPE "contact_point_kind" ADD VALUE 'phone';

ALTER TABLE "contact_points" ALTER COLUMN "verification" DROP NOT NULL,
ALTER COLUMN "verified_at" DROP NOT NULL,
ADD COLUMN "page_url" TEXT;

ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_email_verified_check"
  CHECK ("kind" NOT IN ('work_email', 'personal_email') OR ("verification" IS NOT NULL AND "verified_at" IS NOT NULL));
