// A fixture server file: a mail rendered from the module's messages, `<key>.subject` and `<key>.body`.
declare function renderMail(
  key: string,
  params: Record<string, string | number>,
  locale: string,
): { subject: string; body: string };
export const inviteMail = (name: string, count: number, locale: string) =>
  renderMail("fixture.invite.mail", { name, count }, locale);
