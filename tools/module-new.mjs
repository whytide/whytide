#!/usr/bin/env node
// Creates core/modules/<name> from core/modules/_template: `pnpm module:new <name>`.
// Every `__module__` in the copied files becomes <name>; then `pnpm install` registers the package.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(
    "usage: pnpm module:new <name> (lower-case letters, digits and dashes, starting with a letter)",
  );
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const template = join(root, "core", "modules", "_template");
const target = join(root, "core", "modules", name);
if (existsSync(target)) {
  console.error(`core/modules/${name} already exists`);
  process.exit(1);
}

cpSync(template, target, {
  recursive: true,
  filter: (source) => !/(^|\/)(node_modules|dist)(\/|$)/.test(relative(template, source)),
});
for (const file of walk(target)) {
  const text = readFileSync(file, "utf8");
  if (text.includes("__module__")) {
    writeFileSync(file, text.replaceAll("__module__", name));
  }
}
console.log(`created core/modules/${name}: run pnpm install, then pnpm -F ${name} build`);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}
