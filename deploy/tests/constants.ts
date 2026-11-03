// The fixed values of deploy's tests of production: production.test.ts and the safety case of
// restore.sh (tests/safety/restore-closes-sending.test.ts).

/** What backup.sh writes in a backup folder, and restore.sh reads back. */
export const BACKUP_FILES = ["app.dump", "temporal.dump", "temporal_visibility.dump", "minio.tar"];

/** linkedin's control command in the api's image, from its working directory (no pnpm there). */
export const CONTROL_COMMAND = ["node", "../../modules/linkedin/dist/cli/control.js"];

/** The operator the backup drill opens sending as, before its backup. */
export const DRILL_OPERATOR = "drill";

/** The operator restore.sh closes sending as, whose control event the drill finds after a restore. */
export const RESTORE_OPERATOR = "restore";

/** What a restore changes on purpose: the platform's switches, closed by restore.sh, and their events. */
export const CHANGED_BY_RESTORE = [
  "public.linkedin_platform_controls",
  "public.linkedin_control_events",
];

/**
 * Beta's first migration: every table a migration creates from this one on is beta's, and the drill
 * gives each one a row before its backup (tests/fixtures/beta-tables.sql).
 */
export const FIRST_BETA_MIGRATION = "20261029091739_contacts_suppression";

/** linkedin's limit on its webhook's body (core/modules/linkedin/api/webhooks.ts), 64 KiB. */
export const WEBHOOK_BODY_LIMIT = 64 * 1024;

/** The project name the safety case's stub of docker answers for restore.sh. */
export const STUB_PROJECT = "whytide-restore-stub";

/** The services restore.sh starts by name before it closes sending: Postgres alone, then the api. */
export const STARTED_BEFORE_THE_CLOSE = ["postgres", "api"];
