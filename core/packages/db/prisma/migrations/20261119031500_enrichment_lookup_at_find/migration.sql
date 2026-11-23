-- The email lookup at find (gamma-wr-070). Expand only: a lookup asked for a lead research found has
-- its own trigger, and the request may hold, while it runs, the address a page printed with the
-- person. Personal data: emptied by the lookup when it ends. No row changes, nothing is dropped.
ALTER TYPE "email_lookup_trigger" ADD VALUE 'found';

ALTER TABLE "enrichment_requests" ADD COLUMN "printed_address" TEXT;
