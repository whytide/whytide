// credits' screens (core/apps/web/docs/screens.md): the costs page, /w/{ws}/credits, outside the
// navigation, whose groups are the tester's day, and opened from the balance; the balance, which
// `pnpm web:routes` puts in the shell's `balance` slot, in the header of every workspace page; and the
// cost line in the cost slot of contacts' lead page, /w/{ws}/leads/{personId}.
export const pages = [{ path: "credits", screen: "costs" }];
export const slots = [{ slot: "balance", screen: "balance" }];
export const panels = [{ page: "contacts.lead", slot: "cost", screen: "lead-cost" }];
