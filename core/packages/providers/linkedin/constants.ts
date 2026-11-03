// The LinkedIn port's ceilings on what a send carries (README.md "Sending"): bounds that keep a
// vendor call sane, never a caller's limit. A caller's own limits are lower: messaging's
// LINKEDIN_NOTE_LIMIT for a note, the step's target length for a message. Then the bounds of the
// events parseWebhook gives (README.md "Events"), above LinkedIn's own limits, so that a real
// message never fails the check.

/** A connection request's note: 300 characters, LinkedIn's longest, on Premium (RB-11.2.5). */
export const NOTE_MAX_CHARS = 300;
/** A message: the hard maximum of briefs RB-9.1.2. */
export const MESSAGE_MAX_CHARS = 1900;
/** The step's idempotency key (briefs RB-1.2.4). */
export const IDEMPOTENCY_KEY_MAX_CHARS = 128;
/** An event's key, the provider's event or message id: the length of a ref. */
export const EVENT_KEY_MAX_CHARS = 256;
/** A received message's text, in characters: not in the sources, above LinkedIn's own limit. */
export const EVENT_TEXT_MAX_CHARS = 20_000;
/** A received message's attendees: not in the sources, above LinkedIn's own limit. */
export const EVENT_ATTENDEES_MAX = 50;
