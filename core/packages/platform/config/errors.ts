// The code the time helpers throw (README "Time"): an argument they cannot use, named in `field`.
// It is a caller's fault, never a client's, so the status keeps the `_invalid` suffix from making
// it a 400.
import { AppError, defineErrors } from "../errors/index.ts";

const errors = defineErrors({ time_argument_invalid: { status: 500 } });

export const timeArgumentInvalid = (field: string): AppError =>
  new AppError(errors.time_argument_invalid, { details: { field } });
