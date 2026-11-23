// The id prefixes of inbox's tables (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  thr: "thread",
  msg: "message",
  rlb: "reply_label",
  rdr: "reply_draft",
  rcl: "reply_classification",
});
