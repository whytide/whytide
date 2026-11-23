// The schemas' constants (README.md "Worker"): the key of a file a read takes or writes, under the
// workspace's raw/ (72 hours), as a key relative to its folder; the activities' own copy is
// workflows/constants.ts RAW_KEY, which schemas/ may not import.

/** A JSON file under the workspace's raw/. */
export const RAW_FILE_KEY = /^raw\/[\w./-]+\.json$/;
/** Its key's characters at most. */
export const RAW_FILE_KEY_MAX_CHARS = 512;
