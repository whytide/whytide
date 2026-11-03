// The workspace as the runner sees it: the packages `pnpm -r` runs (every workspace package but the
// root), each with its scripts and its workspace dependencies, and those a step runs in; the files
// git tracks or would track, never an ignored one, so never a build output; and the hash of a step's
// inputs for one package.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type Package = {
  readonly name: string;
  /** Repository-relative, with forward slashes. */
  readonly dir: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** The workspace packages this one depends on, by name. */
  readonly dependsOn: readonly string[];
};

/** A step of steps.json (README.md "Running it"). */
export type Step = {
  readonly name: string;
  readonly cache?: boolean;
  readonly serial?: boolean;
  /** The folders the step runs in; without it, every package that defines the script. */
  readonly only?: readonly string[];
};

/** The packages `step` runs in: those that define its script, within its `only` folders. */
export function stepPackages(step: Step, packages: readonly Package[]): Package[] {
  return packages.filter((p) => step.name in p.scripts && (step.only?.includes(p.dir) ?? true));
}

type Manifest = {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** The root files every step reads; a package under tools/ is an input of every package too. */
const rootInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "biome.json",
  ".node-version",
  ".npmrc",
];

/** Runs a command to completion and returns its output; throws on a non-zero exit. */
export function sh(cwd: string, command: string, args: readonly string[]): string {
  const run = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${run.status}:\n${run.stderr ?? ""}`);
  }
  return run.stdout ?? "";
}

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** Every workspace package but the root, as `pnpm -r` lists them. */
export function workspacePackages(root: string): Package[] {
  const listed = JSON.parse(sh(root, "pnpm", ["-r", "ls", "--depth", "-1", "--json"])) as {
    name: string;
    path: string;
  }[];
  const names = new Set(listed.map((p) => p.name));
  const packages: Package[] = [];
  for (const { name, path } of listed) {
    const dir = relative(root, path).split("\\").join("/");
    if (dir === "") continue;
    const manifest = readManifest(path);
    const dependsOn = new Set<string>();
    for (const field of dependencyFields) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (names.has(dependency) && dependency !== name) dependsOn.add(dependency);
      }
    }
    packages.push({ name, dir, scripts: manifest.scripts ?? {}, dependsOn: [...dependsOn].sort() });
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Content digests of the files git tracks or would track, and the hashes built from them. */
export class Inputs {
  private readonly paths: readonly string[];
  private readonly files = new Map<string, string | undefined>();
  private readonly folders = new Map<string, string>();
  private readonly fixed: string;

  private readonly root: string;
  private readonly packages: readonly Package[];

  constructor(root: string, packages: readonly Package[]) {
    this.root = root;
    this.packages = packages;
    this.paths = sh(root, "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .split("\0")
      .filter(Boolean)
      .sort();
    const pnpm = readManifest(root).packageManager ?? "";
    this.fixed = `node ${process.version}\npnpm ${pnpm}\nroot ${this.digestOf(rootInputs)}\n`;
  }

  /**
   * The hash of everything `step` reads for `pkg`: its files, the files of the workspace packages it
   * depends on and of the tooling, the root configuration, the script's text, the versions.
   */
  hashFor(step: string, pkg: Package): string {
    const byName = new Map(this.packages.map((p) => [p.name, p]));
    const closure = new Set<Package>();
    const visit = (p: Package) => {
      if (closure.has(p)) return;
      closure.add(p);
      for (const name of p.dependsOn) {
        const dependency = byName.get(name);
        if (dependency) visit(dependency);
      }
    };
    visit(pkg);
    for (const p of this.packages) if (p.dir.startsWith("tools/")) visit(p);
    const hash = createHash("sha256").update(
      `${this.fixed}step ${step}\nscript ${pkg.scripts[step] ?? ""}\n`,
    );
    for (const p of [...closure].sort((a, b) => a.dir.localeCompare(b.dir))) {
      hash.update(`${p.dir} ${this.folder(p.dir)}\n`);
    }
    return hash.digest("hex");
  }

  private folder(dir: string): string {
    let digest = this.folders.get(dir);
    if (digest === undefined) {
      digest = this.digestOf(this.paths.filter((path) => path.startsWith(`${dir}/`)));
      this.folders.set(dir, digest);
    }
    return digest;
  }

  private digestOf(paths: readonly string[]): string {
    const hash = createHash("sha256");
    for (const path of paths) {
      const digest = this.file(path);
      if (digest) hash.update(`${path}\0${digest}\n`);
    }
    return hash.digest("hex");
  }

  /** Undefined for a tracked file that is gone from the working tree. */
  private file(path: string): string | undefined {
    if (!this.files.has(path)) {
      const full = join(this.root, path);
      const digest = existsSync(full)
        ? createHash("sha256").update(readFileSync(full)).digest("hex")
        : undefined;
      this.files.set(path, digest);
    }
    return this.files.get(path);
  }
}
