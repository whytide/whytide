// deploy:check's table of adapters (deploy/scripts/constants.ts, ADAPTER_VARIABLES; deploy/README.md
// "Install"): every port, by its PROVIDER_ variable (gamma-en-100), with every adapter the registry
// knows but the fake, each with the variables it cannot run without, its `requires`, in their order.
// Deploy scripts import no module, so this test keeps the table in step: a port added, an adapter
// added to a port, removed, or given another variable fails it until the table follows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { knownAdapterNames, portFolder, registeredAdapters, registeredPorts } from "../index.ts";
import { adapterLoaders } from "../registry.generated.ts";

type Table = {
  readonly ADAPTER_VARIABLES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly FAKE: string;
};
/** deploy's constants, a file of the repository outside this package: imported, never built. */
const TABLE = new URL("../../../../deploy/scripts/constants.ts", import.meta.url).href;

test("deploy:check's table names every port and each of its adapters but the fake, with the variables it cannot run without", async () => {
  // A specifier in a variable: TypeScript leaves it to Node, which strips the file's types.
  const { ADAPTER_VARIABLES: table, FAKE: fake } = (await import(TABLE)) as Table;
  const ports = new Map([...registeredPorts().values()].map((port) => [port.variable, port]));
  assert.ok(Object.keys(table).length > 0);
  assert.deepEqual(
    Object.keys(table).sort(),
    [...ports.keys()].sort(),
    "deploy/scripts/constants.ts holds every port's PROVIDER_ variable",
  );
  for (const [variable, listed] of Object.entries(table)) {
    const port = ports.get(variable);
    assert.ok(port, `${variable} selects no port`);
    const required: Record<string, readonly string[]> = {};
    for (const name of knownAdapterNames(port, adapterLoaders)) {
      if (name === fake) continue;
      await adapterLoaders[`${portFolder(port)}/${name}`]?.();
      required[name] = registeredAdapters(port).get(name)?.requires ?? [];
    }
    assert.deepEqual(
      listed,
      required,
      `${variable}: deploy/scripts/constants.ts follows its adapters`,
    );
  }
});
