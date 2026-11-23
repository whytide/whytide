-- AlterTable
ALTER TABLE "reply_labels" ADD COLUMN     "class_label" TEXT;

-- Hand-written (schema/inbox.prisma's header). The thread owner's label is one of campaigns' 7
-- (REPLY_ACTION_LABELS), or null on beta's rows; beta's label follows it, positive exactly for
-- interested, so that beta-p7-030's export keeps its two words. A nullable column with no default:
-- the previous release's rows and writes, which leave it null, stay valid.
ALTER TABLE "reply_labels" ADD CONSTRAINT "reply_labels_class_label" CHECK (
  "class_label" IS NULL
  OR ("class_label" IN ('interested', 'not_now', 'not_interested', 'out_of_office', 'opt_out',
      'bounce', 'other')
    AND ("label" = 'positive') = ("class_label" = 'interested'))
);
