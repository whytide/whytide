-- AlterEnum: a removed member's accounts are paused with this source (gamma-p6-070), alone in its
-- migration: a value added in a transaction cannot be used in it.
ALTER TYPE "linkedin_switch_source" ADD VALUE 'member_removed';
