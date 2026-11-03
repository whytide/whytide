// The address /: the member's first workspace (GET /v1/me), where sign-in lands unless `next` names a
// page; /sign-in with no session.
import { notFound, redirect } from "next/navigation";
import { data, serverApi } from "../src/api/server.ts";

export default async function Home(): Promise<never> {
  const answer = await (await serverApi()).GET("/v1/me");
  if (answer.response.status === 401) redirect("/sign-in");
  const [first] = (await data(Promise.resolve(answer))).memberships;
  if (first === undefined) notFound();
  redirect(`/w/${first.slug}`);
}
