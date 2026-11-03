import type { Row } from "../../../packages/db/generated/other/client";
import { other } from "../../other";
export const run = (row: Row) => other(row);
