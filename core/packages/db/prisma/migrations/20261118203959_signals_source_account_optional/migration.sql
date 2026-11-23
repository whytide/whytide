-- AlterTable
ALTER TABLE "signal_sources" ALTER COLUMN "sender_account_id" DROP NOT NULL;

-- Hand-written comment (gamma-wr-030; signals' docs/data.md): a source reads through a LinkedIn
-- account, or, for the kind web_research, through none. Expand only: the column keeps its values,
-- and a LinkedIn kind still requires one, in signals' code (createSource), not in the table.
