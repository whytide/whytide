// robots.txt (RFC 9309) for the website fetch (README "The website fetch"): the rules of the groups
// that name `whytide`, else of the `*` groups; the longest matching rule decides, an allow winning a
// tie; `*` matches any run of characters and a final `$` anchors the end. Matching splits a rule at
// its `*`s and finds each piece left to right, so a rule costs linear time, whatever the file holds.

export type RobotsRule = { readonly allow: boolean; readonly path: string };
export type RobotsRules = readonly RobotsRule[];

/** What an unreachable robots.txt means (RFC 9309 §2.3.1.4): nothing may be read. */
export const DISALLOW_ALL: RobotsRules = [{ allow: false, path: "/" }];
const AGENT = "whytide";
const MAX_RULES = 1000;
const MAX_RULE = 512;

/** The rules of a robots.txt for our agent. */
export function parseRobots(text: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | undefined;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (current === undefined || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current !== undefined) {
      if (value !== "" && value.length <= MAX_RULE) {
        current.rules.push({ allow: key === "allow", path: value });
      }
    }
  }
  const named = groups.filter((group) => group.agents.includes(AGENT));
  const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes("*"));
  return chosen.flatMap((group) => group.rules).slice(0, MAX_RULES);
}

/** Whether `rule` matches `path` (the path and the query) from its start. */
function matches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const pieces = (anchored ? rule.slice(0, -1) : rule).split("*");
  // Anchored, the last piece must end the path: each other piece is found leftmost, the most room.
  const last = anchored ? (pieces.pop() ?? "") : "";
  let at = 0;
  for (const [index, piece] of pieces.entries()) {
    const found = index === 0 ? (path.startsWith(piece) ? 0 : -1) : path.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  if (!anchored) return true;
  if (pieces.length === 0) return path === last;
  return path.endsWith(last) && path.length - last.length >= at;
}

/** Whether `rules` let the page at `url` be read. */
export function isAllowed(rules: RobotsRules, url: URL): boolean {
  const path = `${url.pathname}${url.search}`;
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    const longer = best === undefined || rule.path.length > best.path.length;
    const tie = best !== undefined && rule.path.length === best.path.length && rule.allow;
    if (longer || tie) best = rule;
  }
  return best?.allow ?? true;
}
