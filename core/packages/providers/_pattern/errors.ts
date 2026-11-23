// The pattern's own codes (docs/rules/coding.md §6), registered once through the platform's
// defineErrors as a module's errors.ts does. A port's codes are its own, `<port>_<reason>`, declared
// with the port; the three a port gets for free (`<port>_input_invalid`, `<port>_output_invalid`,
// `<port>_error_unmapped`) are registered by definePort.
import { defineErrors } from "@whytide/platform";

export const patternErrors = defineErrors({
  /** A definition that breaks the rules: the name, a code without the prefix, no method. */
  port_invalid: { status: 500 },
  duplicate_port: {},
  /** An adapter name that is not a folder name, or a fake asked to fail with a foreign code. */
  adapter_invalid: { status: 500 },
  duplicate_adapter: {},
  /** An implementation missing a port method or exposing one the port does not declare. */
  port_shape_mismatch: {},
  /** A selector naming no adapter of the port; `details.known` lists the registered names. */
  provider_unknown: {},
  /** No selector: `PROVIDER_<PORT>` is empty. */
  provider_not_configured: {},
  /** A list of adapters naming one twice; `details.adapter` names it. */
  provider_list_invalid: { status: 500 },
  /** A provider ref that is not a non-empty id under an adapter name, or a malformed column. */
  provider_ref_invalid: { status: 500 },
});
