// What "on a site" means for the port (README.md "The method"): the link's host is the site, or one
// of its subdomains, as a search engine's site: operator reads it. The fake, the adapters and the
// contract read it from here.
export const onSite = (url: string, site: string): boolean => {
  const host = new URL(url).hostname;
  return host === site || host.endsWith(`.${site}`);
};
