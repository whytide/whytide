// `pnpm -F api smoke`: GET /health of the running api, at API_PUBLIC_URL or 127.0.0.1:API_PORT (the
// Compose stack's once alpha-p10-070 runs the api there); exits 0 on 200 only.
const base = process.env.API_PUBLIC_URL || `http://127.0.0.1:${process.env.API_PORT ?? 3001}`;
const res = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(10_000) });
process.stdout.write(`smoke: GET ${new URL("/health", base)} ${res.status} ${await res.text()}\n`);
process.exitCode = res.status === 200 ? 0 : 1;
