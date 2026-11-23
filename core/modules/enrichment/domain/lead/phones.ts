// The lead page's phones (gamma-wr-100; README "The Email panel"), in the caller's tenant run: the
// numbers a public page printed with the person, each with the page it came from, never the provider.
// A phone is not an address: the Email panel reads it here and no email reader sees it.
import { phonesOf } from "../phone/keep.ts";
import { personOf } from "./read.ts";

export type LeadPhones = {
  readonly phones: readonly {
    readonly number: string;
    /** The address of the page that printed it; null when none was kept. */
    readonly page: string | null;
    readonly acquiredAt: Date;
  }[];
};

/** The person's phones; enrichment_person_not_found. */
export async function leadPhones(personId: string): Promise<LeadPhones> {
  const person = await personOf(personId);
  return { phones: await phonesOf(person.id) };
}
