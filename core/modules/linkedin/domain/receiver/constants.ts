// The receiver's constants (README.md "The webhook"): where a kept message's file goes, under the
// account's workspace and in raw/, so that the files port keeps it 72 hours at most.

/** The folder of the kept messages' files, relative to the workspace's folder. */
export const MESSAGES_FOLDER = "raw/linkedin/messages/";
/** A message file's name after its event's key hash: `<event_key_hash>.json`. */
export const MESSAGE_FILE_SUFFIX = ".json";
export const MESSAGE_FILE_TYPE = "application/json";
