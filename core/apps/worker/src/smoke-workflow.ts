// The no-op workflow of `pnpm -F worker smoke` (README "Smoke"): it proves that a running worker
// takes work from its task queue. The worker registers it beside the modules' workflows.

export async function worker_smoke(): Promise<string> {
  return "ok";
}
