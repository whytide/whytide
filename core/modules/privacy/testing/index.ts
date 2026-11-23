// privacy's test helpers (README.md "Testing"), for its own tests and the worker's, which import
// them from the build by path, since no package depends on privacy: the client its runs open on,
// and the 30-day rule's cap per run.
export { useClient as usePrivacyClient } from "../domain/client.ts";
export { useRetentionCap } from "../domain/retention/job.ts";
