-- CreateEnum
CREATE TYPE "message_send_status" AS ENUM ('sending', 'sent', 'refused', 'failed');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "error_code" TEXT,
ADD COLUMN     "send_status" "message_send_status";

-- Hand-written (schema/inbox.prisma's header): a reply from the inbox is the user's outbound
-- message with its member, and only such a row carries a send's status; a code only on a reply
-- refused or failed. Every row before this migration has the three null.
ALTER TABLE "messages" ADD CONSTRAINT "messages_send_status" CHECK (
  ("send_status" IS NULL AND "created_by" IS NULL AND "error_code" IS NULL)
  OR (
    "send_status" IS NOT NULL
    AND "direction" = 'out'
    AND "sent_by" = 'user'
    AND "created_by" IS NOT NULL
    AND ("error_code" IS NULL OR "send_status" IN ('refused', 'failed'))
  )
);
