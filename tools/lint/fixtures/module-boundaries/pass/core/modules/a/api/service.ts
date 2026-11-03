import type { Row } from "@whytide/db";
import { other } from "@whytide/other";
import { ids } from "@whytide/platform";
import { score } from "../domain/score.ts";
export const service = (row: Row) => score(other(row), ids);
