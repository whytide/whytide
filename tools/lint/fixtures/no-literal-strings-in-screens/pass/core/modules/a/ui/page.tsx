declare function t(key: string): string;
declare function Icon(props: { name: string; variant: string }): null;
export const Page = () => (
  <main id="leads" className="page" data-testid="leads-page">
    <h1>{t("a.list.title")}</h1>
    <a href="/leads" rel="noopener noreferrer" target="_blank">
      {t("a.nav.leads")}
    </a>
    <button type="submit" aria-label={t("a.list.close")} key="close">
      {t("a.list.save")}
    </button>
    <Icon name="arrow-right" variant="primary" />
    <input type="search" name="query" placeholder={t("a.list.search")} />
    {t("a.list.count")}{" "}
  </main>
);
