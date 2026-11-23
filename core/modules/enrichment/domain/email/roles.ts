// Role addresses (README "The sources reply, website and pattern"; gamma-en-085): a team's or a
// function's mailbox, never a person's, so neither the lead's address nor a sign of the domain's
// pattern. Pure.

/** The local parts of role addresses, after separators and digits are dropped. */
const ROLES: ReadonlySet<string> = new Set([
  ..."info sales contact contacts contactus hello hi support help helpdesk service services".split(
    " ",
  ),
  ..."office team admin administrator careers career jobs job hr recruiting recruitment".split(" "),
  ..."talent press media pr marketing billing invoice invoices accounts accounting finance".split(
    " ",
  ),
  ..."privacy legal compliance dpo gdpr abuse security noreply donotreply postmaster".split(" "),
  ..."webmaster hostmaster mail email enquiries enquiry inquiries inquiry general reception".split(
    " ",
  ),
  ..."orders order shop store partners partnerships feedback newsletter events bookings".split(" "),
  ..."booking hey welcome team investors ir it tech dev operations ops management".split(" "),
]);

/** Whether the address is a role address: its local part, letters only, is on the list. */
export function isRoleAddress(address: string): boolean {
  const local = address.slice(0, address.lastIndexOf("@")).toLowerCase();
  return ROLES.has(local.replace(/[^a-z]/g, ""));
}
