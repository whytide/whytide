// What Postgres answered a statement with, for a test that expects a refusal (42501, permission
// denied) rather than a result: the SQLSTATE from Prisma's raw error, or undefined when the
// statement ran.
type RawError = { message: string; meta?: { code?: unknown } };

/** The SQLSTATE Postgres answered with, or undefined when the statement ran. */
export async function sqlstate(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
    return undefined;
  } catch (error) {
    const { meta, message } = error as RawError;
    const code = meta?.code ?? /Code: `(\w+)`/.exec(message)?.[1];
    return code === undefined ? `no sqlstate: ${message}` : String(code);
  }
}
