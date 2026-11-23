-- AlterEnum
-- Alone in its migration (gamma-p3-070): the value is committed before the next one's CHECK reads it.
ALTER TYPE "message_channel" ADD VALUE 'email';
