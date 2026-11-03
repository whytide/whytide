// The profile read's constants (workflows/index.ts linkedin_read_profile; README.md "Worker").

/**
 * The attempt from which a provider error on a profile read is answered as a refusal, so that the
 * signal run skips that profile instead of failing; the attempts before it fail, and the worker
 * retries them. It must stay at most the worker's attempts of a provider activity (5,
 * ACTIVITY_ATTEMPTS in core/apps/worker/src/retry.ts): past those the activity fails, refusal or not.
 */
export const PROFILE_READ_ATTEMPTS = 3;
