// The language check (domain/drafts/language.ts; gamma-p3-070, "English only"), in pure code on the
// dossier fixture's lead with synthetic headlines, titles and comments: English; each of the six
// other languages of briefs RB-1.2.9; the lead's own comment; a mixed and a short profile, and one
// that repeats a name, written in English; a profile mostly outside the Latin script.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleDossier } from "../domain/dossier/assemble.ts";
import { profileLanguage } from "../domain/drafts/language.ts";
import { inputs } from "./fixtures/dossier/inputs.ts";

/** The fixture's two events, the newer one's comment this one. */
function eventsWith(comment: string) {
  const [older, newer] = inputs.events;
  if (older === undefined || newer?.evidence == null) throw new Error("the fixture's two events");
  return [older, { ...newer, evidence: { ...newer.evidence, commentText: comment } }];
}
/** The fixture lead with this headline and title, and its newer event's comment when given. */
function languageOf(headline: string | null, title: string | null = null, comment?: string) {
  const person = { ...inputs.person, headline, title };
  const events = comment === undefined ? [] : eventsWith(comment);
  return profileLanguage(assembleDossier({ ...inputs, person, events }));
}

test("an English profile is English, and each of the six other languages is `other`, accents or not", () => {
  assert.equal(languageOf("Head of Data at Acme, helping sales teams reach warm leads"), "english");
  const others = [
    "Directrice des ventes chez Acme, nous aidons les équipes avec leur croissance",
    "Leiter Vertrieb bei Acme und Mitglied im Vorstand, wir helfen Teams mit Daten",
    "Director de ventas en Acme, ayudamos a los equipos con sus datos y procesos",
    "Responsabile vendite nella sede di Milano, aiutiamo gli imprenditori con i dati",
    "Gerente de vendas em Lisboa, ajudamos a nossa equipe com os dados",
    "Hoofd verkoop bij Acme, wij helpen bedrijven met hun groei en data",
    "Leiter Vertrieb für Daten und Analyse bei Acme",
  ];
  for (const headline of others) assert.equal(languageOf(headline), "other", headline);
  assert.equal(
    languageOf("Head of Data", "Gerente de vendas em Lisboa e na nossa equipe"),
    "other",
  );
});

test("the lead's own comment counts with the headline and the title", () => {
  const french = "Exactement notre problème : nous perdons des leads, et les outils sont lents.";
  assert.equal(languageOf("Head of Data at Acme", "Head of Data", french), "other");
  assert.equal(
    languageOf("Head of Data at Acme", "Head of Data", "Exactly our problem."),
    "english",
  );
});

test("a mixed profile, where English has as many hits or more, and a short one are written in English", () => {
  const mixed = [
    "Head of Sales for the Iberian market at Acme, with our team in Lisboa: vendas em Portugal",
    "Head of Sales at Acme, for the teams of our partners in Lisboa: vendas, equipe e os clientes",
    "CEO",
    "Directeur",
    "Acme · Lisboa",
  ];
  for (const headline of mixed) assert.equal(languageOf(headline), "english", headline);
  assert.equal(languageOf(null), "english");
  assert.equal(languageOf("", "", ""), "english");
});

test("a word said again counts once, so a name repeated three times is not another language", () => {
  const named: [string, string | null][] = [
    ["Sales @ Uber | Uber for Business", "Account Executive, Uber for Business"],
    ["Realtor in Las Vegas | Las Vegas homes | Las Vegas luxury", null],
    ["Chrome OS, Android OS, Fuchsia OS", null],
  ];
  for (const [headline, title] of named) {
    assert.equal(languageOf(headline, title), "english", headline);
  }
});

test("a profile whose letters are mostly outside the Latin script is `other`, a Latin name in it aside", () => {
  const scripts = [
    "営業部長 データ分析チーム",
    "Руководитель отдела продаж в Acme",
    "Διευθυντής πωλήσεων στην Acme",
    "مدير المبيعات في Acme",
  ];
  for (const headline of scripts) assert.equal(languageOf(headline), "other", headline);
  assert.equal(languageOf("Head of Data at Acme 東京"), "english");
});
