// The step messages:check of tools/ci/steps.json, `pnpm -F platform messages:check`: every key
// used exists, none is unused, the ICU parses, the convention holds (README, "Messages and the i18n
// runtime"). One line per problem, as the lint prints them; exit code 1 when one remains.
import { checkMessages, formatProblem } from "./check.ts";
import { workspaceRoot } from "./messages.ts";

const say = (text: string) => process.stdout.write(`${text}\n`);
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const { problems, summary } = checkMessages(workspaceRoot());
for (const problem of problems) say(formatProblem(problem));
const keys = `${count(summary.keys, "key")} in ${count(summary.files, "message file")}`;
const uses = `${count(summary.uses, "use")} and ${count(summary.codes, "error code")}`;
const seen = `${keys}, ${uses} in ${count(summary.sources, "source file")}`;
const verdict = problems.length ? `${count(problems.length, "problem")};` : "ok,";
say(`messages:check: ${verdict} ${seen}`);
process.exitCode = problems.length ? 1 : 0;
