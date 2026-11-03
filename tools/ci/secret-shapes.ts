// The secret-shape check (docs/rules/security.md §4, architecture §15): no Prisma field and no log
// key is named like a password, a cookie or a second-factor secret, which Whytide never stores. The
// step secrets:scan runs it after gitleaks, over every *.prisma file git tracks or would track and
// every log-schema.json, the keys a package's log-schema test allows; or over the files named as
// arguments. secret-shapes.json holds the shapes and the exceptions, each with a reason.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sh } from "./workspace.ts";

type Config = {
  readonly shapes: Readonly<Record<string, readonly string[]>>;
  readonly allowed: readonly { file: string; field: string; reason: string }[];
};
type Name = { readonly name: string; readonly line: number };

const root = resolve(import.meta.dirname, "..", "..");
const config = JSON.parse(
  readFileSync(join(import.meta.dirname, "secret-shapes.json"), "utf8"),
) as Config;
const say = (text: string) => process.stdout.write(`${text}\n`);
const named = process.argv.slice(2);
const files = named.length
  ? named
  : sh(root, "git", [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.prisma",
      "*log-schema.json",
    ])
      .split("\0")
      .filter((file) => file && !file.startsWith("tools/ci/fixtures/"));

const findings: string[] = [];
for (const file of files) {
  const text = readFileSync(resolve(root, file), "utf8");
  for (const { name, line } of file.endsWith(".prisma") ? prismaFields(text) : jsonKeys(text)) {
    const shape = shapeOf(name);
    const allowed = config.allowed.some((a) => a.file === file && a.field === name && a.reason);
    if (shape && !allowed) findings.push(`${file}:${line}: ${name} looks like ${shape}`);
  }
}
if (findings.length) {
  say(findings.join("\n"));
  say(
    `secret-shapes: ${findings.length} name${findings.length === 1 ? "" : "s"} shaped like a password, a cookie or a second-factor secret, which Whytide never stores (docs/rules/security.md §1, §4)`,
  );
  process.exit(1);
}
say(`secret-shapes: ok, ${files.length} file${files.length === 1 ? "" : "s"} checked`);

/** The shape a name has, if any: its words, snake_case or camelCase, against the configured ones. */
function shapeOf(name: string): string | undefined {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  for (const [shape, list] of Object.entries(config.shapes)) {
    if (list.some((word) => new RegExp(`(^|_)${word}(_|$)`).test(words))) return shape;
  }
  return undefined;
}

/** The fields of every model, view and composite type, and the column names their @map gives. */
function prismaFields(text: string): Name[] {
  const names: Name[] = [];
  let inside = false;
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (/^(model|view|type)\s+\S+\s*\{/.test(line)) inside = true;
    else if (line === "}") inside = false;
    else if (inside && !line.startsWith("//") && !line.startsWith("@@")) {
      const field = /^([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(line)?.[1];
      if (field) names.push({ name: field, line: index + 1 });
      const mapped = /@map\("([^"]+)"\)/.exec(line)?.[1];
      if (mapped) names.push({ name: mapped, line: index + 1 });
    }
  });
  return names;
}

/** Every key of a JSON document and every string in its arrays: the keys a log line may carry. */
function jsonKeys(text: string): Name[] {
  const names: Name[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value)
        typeof item === "string" ? names.push({ name: item, line: 0 }) : walk(item);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        names.push({ name: key, line: 0 });
        walk(item);
      }
    }
  };
  walk(JSON.parse(text));
  return names;
}
