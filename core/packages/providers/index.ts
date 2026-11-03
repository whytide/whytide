// The public interface of @whytide/providers (docs/architecture.md §4.1, §9): the port pattern, the
// registry and the provider_refs helper. The ports arrive with their own tasks and are exported from
// here, one `export * from "./<port>/port.ts";` line per port, in alphabetical order. The contract
// harness is `@whytide/providers/testing`, never imported by a host.
export * from "./_pattern/index.ts";
export * from "./app-mail/port.ts";
export * from "./auth/port.ts";
export * from "./files/port.ts";
export * from "./linkedin/port.ts";
export * from "./llm/port.ts";
export * from "./registry.ts";
