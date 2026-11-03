// privacy's code (core/packages/platform/README.md "Errors"), with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /**
   * The erasers cannot be ordered: a module registered twice, a dependency on a module without an
   * eraser, or a cycle; `details.reason` and `details.modules`. A developer's mistake, which
   * tests/order.test.ts finds before the command runs. 500.
   */
  eraser_order_invalid: { status: 500 },
});
