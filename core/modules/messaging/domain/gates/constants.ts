// The gates' values (README.md "The writer", "Decided here"; beta-p3-020): the characters an edited or
// approved text may have, and the phrases of the colleague-signal gate; an email's words and
// subject, the act phrases, the near-duplicate measure and the language check's words
// (gamma-p3-070). Plain values; nothing imported.

/** The most characters a message may have: above it, no text passes and no edit is saved. */
export const MESSAGE_HARD_LIMIT = 1_900;

/** The fewest characters a text has: any message, and a lead's note. */
export const TEXT_MIN_CHARACTERS = 1;
/** The fewest characters of a sequence step's note: an empty one is an invitation with no note. */
export const STEP_NOTE_MIN_CHARACTERS = 0;

/**
 * The words that point at a colleague of the person, so at a signal of someone else at their company
 * (beta's rules we keep: "your colleague liked our post"): refused as whole words, case and marks
 * aside, each also with its last word in the plural ("your colleagues"). English only, as beta is.
 */
export const COLLEAGUE_SIGNAL_PHRASES = [
  "your colleague",
  "your coworker",
  "your co-worker",
  "your teammate",
  "someone on your team",
  "someone from your team",
  "people at your company",
  "others at your company",
  "your boss",
  "your manager",
] as const;

/**
 * The words a written email's body has: 120 is F09 §6's first touch; 50, and the same range for a
 * follow-up, are not in the sources. A member's typed body is held to characters, as a message is.
 */
export const EMAIL_WORD_RANGE = { min: 50, max: 120 } as const;
/** A first email's subject: at most this many words (F09 §6) and characters (not in the sources). */
export const EMAIL_SUBJECT_MAX_WORDS = 6;
export const EMAIL_SUBJECT_MAX_CHARACTERS = 60;
/** A subject's openings that fake a reply or a forward (F09 §10 R3), in any case. */
export const SUBJECT_PREFIXES = ["re:", "fw:", "fwd:"] as const;

/**
 * The words that name the act of a public signal rather than its topic (briefs RB-10.2.3, the
 * default policy: "mention the topic, not 'I saw you liked'"): refused as whole words, case and
 * marks aside, on every channel. A text says what the post was about, never that the person liked,
 * commented on or reacted to it, nor that they viewed a profile. English only, as the writer is.
 */
export const SIGNAL_ACT_PHRASES = [
  "saw you liked",
  "noticed you liked",
  "see you liked",
  "you liked my post",
  "you liked our post",
  "you reacted",
  "your reaction to",
  "your reaction on",
  "saw you commented",
  "you commented on",
  "saw your comment",
  "your comment on",
  "thanks for engaging",
  "thanks for liking",
  "thanks for the like",
  "thanks for commenting",
  "thanks for your comment",
  "thanks for reacting",
  "engaged with my post",
  "engaged with our post",
  "viewed my profile",
  "visited my profile",
  "looked at my profile",
] as const;

/**
 * The near-duplicate gate (briefs RB-10.2.5, reduced: word overlap rather than cosine): a body's
 * runs of this many words against each other email draft of its mailbox made or approved in the
 * window; a Jaccard similarity at or above the threshold fails. None is in the sources.
 */
export const NEAR_DUPLICATE_WINDOW_HOURS = 24;
export const NEAR_DUPLICATE_SHINGLE_WORDS = 3;
export const NEAR_DUPLICATE_THRESHOLD = 0.8;
/** The decimals a similarity keeps in its issue. */
export const SIMILARITY_DECIMALS = 2;

/**
 * The language check's words (domain/drafts/language.ts; not in the sources): frequent function
 * words of English and of the six other languages of briefs RB-1.2.9, as words() writes them (no
 * accent, lower case), each list without a word another one also uses often. A language with at
 * least LANGUAGE_MIN_HITS different words of its list, and more different ones than English, holds
 * the draft back; a word said again counts once. German has "ueber" and not "uber", the brand.
 */
export const LANGUAGE_STOPWORDS = {
  english: `the and of to for with at are we our you your my it this that from by be have has not
    but or can about who what how all more every help helping`,
  french: `les une est et pour dans avec sur nous vous notre votre vos pas chez aux au cette ces sont
    leur aussi tres`,
  german: `der und ist mit fur fuer bei von zu zum zur im wir ich sie nicht ein eine einer einen einem
    auf den dem auch sind unser unsere ueber oder`,
  spanish: `el los las y sus nuestro nuestra nuestros nuestras nosotros muy tambien donde ayudo
    ayudamos ventas hacia`,
  italian: `gli della delle dei degli nel nella nelle alla alle sono siamo nostro nostra nostri anche
    piu molto ogni aiutiamo vendite che di`,
  portuguese: `os uma ao aos nas em muito nosso nossa nossos voce sao sou tambem ajudo ajudamos
    vendas equipe pelo pela onde`,
  dutch: `het een voor dat wij ik jij ons onze zijn niet ook naar bij aan uit worden wordt verkoop
    helpen wat hoe geen maar bedrijven`,
} as const;
export const LANGUAGE_MIN_HITS = 3;
/**
 * What textLanguage (domain/drafts/language.ts) answers: English, also for a text too short or mixed
 * to tell; one of the other lists' languages; `other` for letters mostly outside the Latin script.
 */
export const TEXT_LANGUAGES = [
  "english",
  "french",
  "german",
  "spanish",
  "italian",
  "portuguese",
  "dutch",
  "other",
] as const satisfies readonly (keyof typeof LANGUAGE_STOPWORDS | "other")[];
export type TextLanguage = (typeof TEXT_LANGUAGES)[number];
