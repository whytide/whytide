// Typed configuration from the environment (docs/rules/coding.md §8): a block of variables declared
// once with Zod and read at start, failing with the variable's name. A variable wrapped in secret()
// carries `# secret` in deploy/.env.example and is not enumerable on the config object, so spreading
// or logging the object leaks nothing. env-check.ts keeps the file and the declarations equal.
import { z } from "zod";
import { AppError, defineErrors } from "../errors/index.ts";

export type Env = Readonly<Record<string, string | undefined>>;
type Shape = Record<string, z.ZodType>;

const errors = defineErrors({ config_invalid: {} });

export function secret<T extends z.ZodType>(schema: T): T {
  return schema.meta({ secret: true }) as T;
}

/** Reads the block's variables from `env` once; an empty value counts as unset, so defaults apply. */
export function defineConfig<S extends Shape>(
  block: string,
  shape: S,
  env: Env = process.env,
): Readonly<z.infer<z.ZodObject<S>>> {
  const given = Object.keys(shape).map((name) => [name, env[name] === "" ? undefined : env[name]]);
  const result = z.object(shape).safeParse(Object.fromEntries(given));
  if (!result.success) {
    const variables = result.error.issues.map(
      (issue) => `${String(issue.path[0])}: ${issue.message}`,
    );
    throw new AppError(errors.config_invalid, { details: { block, variables } });
  }
  const values = result.data as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(shape)) {
    if (values[name] === undefined) continue;
    const enumerable = schema.meta()?.secret !== true;
    Object.defineProperty(config, name, { value: values[name], enumerable });
  }
  return Object.freeze(config) as Readonly<z.infer<z.ZodObject<S>>>;
}
