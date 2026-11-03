// The credits client and the price registry (architecture §4.3 rule 5, §10; coding §3, §7): what a
// module calls for a priced action, reserve, then commit or release, and where it declares the
// prices of its actions. The credits module implements the client and binds it at the api's and the
// worker's start, so this package depends on no module; a call before that fails with
// credits_not_bound. The prices assemble here as the modules load; the credits module writes them
// to price_list at the api's start (core/modules/credits/README.md "Declaring a price").
import { AppError, defineErrors } from "../errors/index.ts";

/** How long a reservation holds: 15 minutes for work in a request, 24 hours for a workflow's. */
export type CreditsLease = "sync" | "async";
export type ReserveInput = {
  /** The workspace of the caller's tenant run, which every call runs inside. */
  readonly workspaceId: string;
  /** A priced action, `<module>.<name>`, declared with definePrices. */
  readonly action: string;
  /** Units of the action's price: the credits reserved are price × quantity. */
  readonly quantity: number;
  /** A repeat in the workspace returns the first reservation. */
  readonly idempotencyKey: string;
  /** The id of what the action is for (`lead_…`), never a person's data. */
  readonly subjectRef: string;
  readonly lease: CreditsLease;
};
/** A reservation or its commit: the usage row and its credits, a decimal string. */
export type CreditsUsage = { readonly usageId: string; readonly credits: string };
/** The organization's wallet as one of its workspaces sees it; amounts are decimal strings. */
export type CreditsBalance = {
  readonly available: string;
  readonly granted: string;
  readonly reserved: string;
  readonly committed: string;
  /** The end of the subscription's current period; null before the organization has one. */
  readonly periodEnd: Date | null;
};
export type CreditsPrice = {
  readonly action: string;
  readonly credits: string;
  readonly unit: string;
  readonly version: number;
};
/** Every method runs inside the caller's own tenant run, a request's or an activity's. */
export type CreditsClient = {
  reserve(input: ReserveInput): Promise<CreditsUsage>;
  /** Credits for the actual quantity, never above the reservation; a repeat returns the first. */
  commit(usageId: string, actualQuantity?: number): Promise<CreditsUsage>;
  release(usageId: string): Promise<void>;
  balance(workspaceId: string): Promise<CreditsBalance>;
  priceOf(action: string): Promise<CreditsPrice>;
};

/** The codes a caller handles; the credits module registers them, with their messages. */
export const creditsCodes = {
  insufficient_credits: "insufficient_credits",
  usage_not_open: "usage_not_open",
  credits_not_bound: "credits_not_bound",
} as const;

let bound: CreditsClient | undefined;

/** The credits module's implementation, at the api's and the worker's start; a later one replaces it. */
export function bindCreditsClient(implementation: CreditsClient): void {
  bound = implementation;
}

function client(): CreditsClient {
  if (!bound) throw new AppError(creditsCodes.credits_not_bound);
  return bound;
}

/** What a module calls: each method goes to the bound implementation. */
export const credits: CreditsClient = Object.freeze({
  reserve: async (input: ReserveInput) => client().reserve(input),
  commit: async (usageId: string, actualQuantity?: number) =>
    client().commit(usageId, actualQuantity),
  release: async (usageId: string) => client().release(usageId),
  balance: async (workspaceId: string) => client().balance(workspaceId),
  priceOf: async (action: string) => client().priceOf(action),
});

/** A priced action as its module declares it: `credits` per `unit` (`lead`, `profile`), 0 or more. */
export type PriceDefinition = {
  readonly action: string;
  readonly credits: number;
  readonly unit: string;
};
export type RegisteredPrice = PriceDefinition & { readonly source: string };
type Actions<T extends readonly PriceDefinition[]> = { readonly [A in T[number]["action"]]: A };

export const priceErrors = defineErrors({
  invalid_price_definition: {},
  duplicate_price_action: {},
});

const ACTION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const UNIT = /^[a-z][a-z0-9_]{0,39}$/;
const prices = new Map<string, RegisteredPrice>();

/**
 * Registers a module's priced actions from its prices.ts, `source` being that file's
 * `import.meta.url`: an action two modules price fails at start naming both files, and a malformed
 * one with invalid_price_definition. Returns the actions as themselves.
 */
export function definePrices<const T extends readonly PriceDefinition[]>(
  definitions: T,
  source: string,
): Actions<T> {
  for (const { action, credits, unit } of definitions) {
    const valid =
      typeof source === "string" &&
      source !== "" &&
      ACTION.test(action) &&
      typeof credits === "number" &&
      Number.isFinite(credits) &&
      credits >= 0 &&
      UNIT.test(unit);
    if (!valid) {
      throw new AppError(priceErrors.invalid_price_definition, { details: { action, source } });
    }
    const first = prices.get(action);
    if (first) {
      const details = { action, sources: [first.source, source] };
      throw new AppError(priceErrors.duplicate_price_action, { details });
    }
    prices.set(action, Object.freeze({ action, credits, unit, source }));
  }
  const actions = definitions.map(({ action }) => [action, action]);
  return Object.freeze(Object.fromEntries(actions)) as Actions<T>;
}

export const registeredPrices = (): ReadonlyMap<string, RegisteredPrice> => prices;
