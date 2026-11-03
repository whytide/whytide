// The registry of erasers (README.md "Erasers"): every module that holds a person's rows erases them
// itself, through a function of its index.ts, in the caller's tenant run (architecture §4.3).
// privacy registers each module's function with defineEraser (erasers.ts), since no module may import
// privacy, which imports theirs; registeredErasers() gives them in dependency order. Pure: nothing here
// reaches the database.
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";

/** The rows an eraser deleted, by table. */
export type ErasureCounts = Readonly<Record<string, number>>;

export type Eraser = {
  /** The module or package whose tables it erases: its schema file's name. */
  readonly module: string;
  /** The modules whose rows this module's rows name (a decision record's id): their erasers run after this one. */
  readonly dependsOn: readonly string[];
  /** Deletes the person's rows in the caller's tenant run, through its tenantClient. */
  readonly erase: (personId: string) => Promise<ErasureCounts>;
};

const registry = new Map<string, Eraser>();

/** Registers a module's eraser; eraser_order_invalid when the module has one already. */
export function defineEraser(eraser: Eraser): Eraser {
  if (registry.has(eraser.module)) invalid("duplicate", [eraser.module]);
  const defined = Object.freeze({ ...eraser, dependsOn: Object.freeze([...eraser.dependsOn]) });
  registry.set(eraser.module, defined);
  return defined;
}

/** The registered erasers in the order they run (orderErasers). */
export function registeredErasers(): Eraser[] {
  return orderErasers([...registry.values()]);
}

/**
 * The erasers in dependency order: each runs before the erasers of the modules it depends on, and
 * among those free to run, by module name. eraser_order_invalid for a module twice, a dependency on a
 * module without an eraser, or a cycle.
 */
export function orderErasers(erasers: readonly Eraser[]): Eraser[] {
  const byModule = new Map(erasers.map((eraser) => [eraser.module, eraser]));
  if (byModule.size < erasers.length) {
    const twice = erasers.filter(
      (eraser, i) => erasers.findIndex((e) => e.module === eraser.module) < i,
    );
    invalid(
      "duplicate",
      twice.map((eraser) => eraser.module),
    );
  }
  const unknown = erasers.flatMap((eraser) => eraser.dependsOn.filter((m) => !byModule.has(m)));
  if (unknown.length > 0) invalid("unknown_dependency", unknown);
  // How many erasers still have to run before each one: those that depend on it.
  const before = new Map(erasers.map((eraser) => [eraser.module, 0]));
  for (const eraser of erasers) {
    for (const module of eraser.dependsOn) before.set(module, (before.get(module) ?? 0) + 1);
  }
  const free = erasers.filter((eraser) => before.get(eraser.module) === 0).map((e) => e.module);
  const order: Eraser[] = [];
  while (free.length > 0) {
    free.sort();
    const next = byModule.get(free.shift() as string) as Eraser;
    order.push(next);
    for (const module of next.dependsOn) {
      const left = (before.get(module) ?? 0) - 1;
      before.set(module, left);
      if (left === 0) free.push(module);
    }
  }
  if (order.length < erasers.length) {
    const stuck = erasers.filter((eraser) => !order.includes(eraser)).map((e) => e.module);
    invalid("cycle", stuck.sort());
  }
  return order;
}

function invalid(reason: string, modules: readonly string[]): never {
  throw new AppError(errors.eraser_order_invalid, { details: { reason, modules: [...modules] } });
}
