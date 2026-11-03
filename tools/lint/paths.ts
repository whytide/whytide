// Path helpers for repository-relative paths with forward slashes. No file system here.

export function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

export function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

export function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "..";
}

/** The repository-relative target of a relative import, or a path starting with `..` when it leaves the root. */
export function resolveRelative(fromFile: string, specifier: string): string {
  return normalize(`${dirname(fromFile)}/${specifier}`);
}

/** Whether `path` is `folder` or inside it. */
export function isIn(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Whether a specifier names `pkg` or a subpath of it. */
export function isPackageOf(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

export type ModuleLocation = {
  readonly edition: "core" | "ee";
  readonly name: string;
  /** The path inside the module: `domain/score.ts`, `index.ts`, or `` for the folder itself. */
  readonly rest: string;
};

export function moduleOf(path: string): ModuleLocation | undefined {
  const match = /^(core|ee)\/modules\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match || match[2] === "_template") return undefined;
  return { edition: match[1] as "core" | "ee", name: match[2] ?? "", rest: match[3] ?? "" };
}

/** `@whytide/<name>` or `@whytide/<name>/<rest>`. */
export function workspaceTarget(specifier: string): { name: string; rest: string } | undefined {
  const match = /^@whytide\/([^/]+)(?:\/(.*))?$/.exec(specifier);
  return match ? { name: match[1] ?? "", rest: match[2] ?? "" } : undefined;
}

/** The folder of the workspace package `@whytide/<name>`, found on disk; packages are named after their folder. */
export function locatePackage(name: string, exists: (path: string) => boolean): string | undefined {
  return [
    `core/modules/${name}`,
    `core/packages/${name}`,
    `core/apps/${name}`,
    `ee/modules/${name}`,
  ].find(exists);
}

/** A folder that can hold a port or an adapter: not `tests/`, `testing/` or a `_*` folder. */
function isPortOrAdapter(name: string | undefined): boolean {
  return name !== undefined && name !== "tests" && name !== "testing" && !name.startsWith("_");
}

/** `core/packages/providers/<port>/<adapter>/...`: one adapter per folder, the fakes included; never `tests/`, `testing/` or `_*`. */
export function isAdapterFolder(path: string): boolean {
  const match = /^core\/packages\/providers\/([^/]+)\/([^/]+)\//.exec(path);
  return isPortOrAdapter(match?.[1]) && isPortOrAdapter(match?.[2]);
}

/**
 * Test code: the `tests/` of a package, a module or a host, and a port's `tests/`, test helpers
 * (`testing/`) and contract suite (`contract.ts`); an adapter's own tests sit in its adapter folder.
 */
export function isTestCode(path: string): boolean {
  if (/^(?:core|ee)\/(?:apps|modules|packages)\/[^/]+\/tests\//.test(path)) return true;
  const match = /^core\/packages\/providers\/([^/]+)\/(?:tests\/|testing\/|contract\.ts$)/.exec(
    path,
  );
  return isPortOrAdapter(match?.[1]);
}
