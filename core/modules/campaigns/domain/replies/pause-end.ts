// When an out-of-office pause ends (README.md "Reply actions"), pure:
// CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS after the return date the reply names, Monday to Friday, at
// OOO_RESUME_TIME in the sender account's zone, through platform's addBusinessDays (holidays are not
// counted), so a Friday's return resumes on the Monday, and 0 on the return date itself; without a
// date, CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS after the reply. The days are settings.ts's (README.md
// "Settings").
import { addBusinessDays, instantAt, MONDAY_TO_FRIDAY } from "@whytide/platform";
import { settings } from "../../settings.ts";
import { MS_PER_DAY } from "../constants.ts";
import { OOO_RESUME_TIME } from "./constants.ts";

/** The instant the out-of-office pause ends (the file's header); `returnDate` is `YYYY-MM-DD`. */
export function outOfOfficeUntil(input: {
  readonly returnDate: string | null;
  readonly repliedAt: Date;
  readonly timeZone: string;
}): Date {
  const { returnDate, repliedAt, timeZone } = input;
  if (returnDate === null) {
    return new Date(repliedAt.getTime() + settings.CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS * MS_PER_DAY);
  }
  const back = instantAt(returnDate, OOO_RESUME_TIME, timeZone);
  const days = settings.CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS;
  return addBusinessDays(back, days, timeZone, MONDAY_TO_FRIDAY);
}
