import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AppError } from "../errors/index.ts";
import { errors } from "./errors.ts";
import { parseKey } from "./keys.ts";
import { canonicalLocale, defaultLocale, localeChain } from "./locale.ts";

/** The bundle next-intl consumes: keys nested by segment, `{ contacts: { list: { empty: "…" } } }`. */
export type Messages = { readonly [segment: string]: string | Messages };

export type MessageRoot = {
  /** The folder name, which is every key's first segment: a module's name, `platform`, `ui` or `web`. */
  readonly module: string;
  /** The folder, absolute. */
  readonly dir: string;
  readonly kind: "module" | "package";
};

export type LoadOptions = {
  /** The repository root; the workspace this file sits in when unset. */
  readonly root?: string;
  /** Roots outside the repository's list: the web host's test modules (`web:routes --fixtures`). */
  readonly extraRoots?: readonly MessageRoot[];
};

type Flat = Map<string, { value: string; file: string }>;

/** The workspace root: the nearest folder above `from` with a pnpm-workspace.yaml, as the lint finds it. */
export function workspaceRoot(from: string = import.meta.dirname): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) {
      throw new AppError(errors.workspace_root_not_found, { details: { from } });
    }
  }
}

/** The folders that hold messages: every module (never the template), the platform and ui packages and the web host, by name. */
export function messageRoots(root: string): MessageRoot[] {
  const roots: MessageRoot[] = [];
  const modules = join(root, "core", "modules");
  if (existsSync(modules)) {
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "_template") continue;
      roots.push({ module: entry.name, dir: join(modules, entry.name), kind: "module" });
    }
  }
  const packages = [
    ["platform", "packages"],
    ["ui", "packages"],
    ["web", "apps"],
  ] as const;
  for (const [name, folder] of packages) {
    const dir = join(root, "core", folder, name);
    if (existsSync(dir)) roots.push({ module: name, dir, kind: "package" });
  }
  return roots.sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * A root's message file for a locale: the first that exists of the tag's own (`zh-Hant-TW.json`),
 * its prefixes (`zh-Hant.json`, `zh.json`) and the fallback's; undefined when none exists.
 */
export function messageFile(
  root: MessageRoot,
  locale: string,
  fallback: string,
): string | undefined {
  const candidates = [...new Set([...localeChain(locale), fallback])];
  return candidates
    .map((tag) => join(root.dir, "messages", `${tag}.json`))
    .find((path) => existsSync(path));
}

/** One message file: a flat object of `module.screen.purpose` keys to ICU strings, nothing else. `file` is how the fault names it. */
export function readMessages(path: string, file: string = path): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    const reason = `not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    throw new AppError(errors.invalid_messages, { details: { file, reason }, cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const reason = "a message file is one object of keys to strings";
    throw new AppError(errors.invalid_messages, { details: { file, reason } });
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      const reason =
        "the value is not a string; a message file is flat, module.screen.purpose to text";
      throw new AppError(errors.invalid_messages, { details: { file, key, reason } });
    }
  }
  return parsed as Record<string, string>;
}

/**
 * The bundle of a locale: every message file merged into one nested object. A key defined in two
 * files fails the build with both file names in `details`; a key off the convention fails it too.
 * Nothing is written: `buildMessages` writes.
 */
export function loadMessages(locale: string, options: LoadOptions = {}): Messages {
  const tag = canonicalLocale(locale);
  const root = options.root ?? workspaceRoot();
  const fallback = defaultLocale();
  const flat: Flat = new Map();
  for (const messageRoot of [...messageRoots(root), ...(options.extraRoots ?? [])]) {
    const path = messageFile(messageRoot, tag, fallback);
    if (!path) continue;
    const file = relativePath(root, path);
    for (const [key, value] of Object.entries(readMessages(path, file))) {
      const first = flat.get(key);
      if (first) {
        const details = { key, files: [first.file, file] };
        throw new AppError(errors.message_conflict, { details });
      }
      const parsed = parseKey(key);
      if (!parsed.ok) {
        const details = { file, key, reason: parsed.reason };
        throw new AppError(errors.invalid_messages, { details });
      }
      if (parsed.key.module !== messageRoot.module) {
        const reason = `starts with ${parsed.key.module}, not with the folder's name, ${messageRoot.module}`;
        throw new AppError(errors.invalid_messages, { details: { file, key, reason } });
      }
      flat.set(key, { value, file });
    }
  }
  return nest(flat);
}

/**
 * The bundle of a locale written where the web host's build asks, under a `*.generated.*` name so
 * git ignores it (`messages/en.generated.json` here, for example), and returned.
 */
export function buildMessages(
  locale: string,
  outFile: string,
  options: LoadOptions = {},
): Messages {
  const messages = loadMessages(locale, options);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(messages, null, 2)}\n`);
  return messages;
}

/** A path relative to the root with forward slashes, as messages and problems print it. */
export function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * `contacts.list.empty` to `{ contacts: { list: { empty } } }`. The nodes have no prototype, so a
 * segment such as `constructor` is only a key; a key that is both a message and a namespace fails.
 */
function nest(flat: Flat): Messages {
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, { value, file }] of flat) {
    const segments = key.split(".");
    const leaf = segments.pop() ?? "";
    let node = out;
    for (const segment of segments) {
      const next: unknown = Object.hasOwn(node, segment) ? node[segment] : Object.create(null);
      if (typeof next !== "object" || next === null) {
        const reason = `nests under ${segment}, which is a message itself`;
        throw new AppError(errors.message_conflict, { details: { key, file, reason } });
      }
      node[segment] = next;
      node = next as Record<string, unknown>;
    }
    if (Object.hasOwn(node, leaf)) {
      const reason = "is also a namespace of other keys";
      throw new AppError(errors.message_conflict, { details: { key, file, reason } });
    }
    node[leaf] = value;
  }
  return out as Messages;
}
