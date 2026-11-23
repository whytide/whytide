-- AlterTable
ALTER TABLE "criterion_verdicts" ADD COLUMN     "member_note" TEXT,
ADD COLUMN     "member_set_at" TIMESTAMPTZ,
ADD COLUMN     "member_set_by" TEXT,
ADD COLUMN     "member_verdict" "qualification_verdict",
ALTER COLUMN "verdict" DROP NOT NULL;

-- Hand-written (prisma/schema/qualification.prisma points here; core/modules/qualification README
-- "A member's verdict"). A row holds the model's verdict, a member's, or both; a member's verdict
-- comes with who set it and when, and a note only beside it, 500 characters at most.
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_some_verdict" CHECK ("verdict" IS NOT NULL OR "member_verdict" IS NOT NULL);
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_member_part" CHECK (("member_verdict" IS NULL AND "member_set_by" IS NULL AND "member_set_at" IS NULL AND "member_note" IS NULL) OR ("member_verdict" IS NOT NULL AND "member_set_by" IS NOT NULL AND "member_set_at" IS NOT NULL AND char_length(coalesce("member_note", '')) <= 500));
