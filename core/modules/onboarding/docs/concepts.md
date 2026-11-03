# onboarding: concepts

- **Company Knowledge**: what the workspace's own company sells, to whom and how it speaks; one record per workspace, edited in place, with a version. The drafter fills it from the website (alpha-p4-030), the tester corrects it, the writer reads it for every message.
- **Website** (`sourceUrl`): the company's site, an absolute `http` or `https` address; its host is the company's domain, which the own-employee filter compares with a lead's (alpha-p8).
- **Content fields**: the one-liner, the long description, the products and offers, the customers' pain points, the features and benefits, the proof points, the competitors and the tone. A proof point is a text with, optionally, the page that backs it.
- **Field source**: who wrote a content field last, an AI draft (with the page it came from) or a person, and when. A save marks each changed field `human`; an accepted draft marks the fields it wrote `ai_draft`, and never replaces a `human` one unless the person asks.
- **Fetch status**: `none`, `fetching`, `fetched` (the drafter reading the pages), `drafted` or `failed`, the state of a Draft's run, with its time and its machine error code.
- **Pending draft**: what the drafter made of the pages, each value with its page and a quote of it, kept beside the record until a person accepts or discards it; nothing of it reaches the record before.
- **Draft from website**: the press that reads the website and, from alpha-p4-030, drafts the record from it; each Draft is a run (`draftRunId`), and the latest one wins.
- **Website page**: a page a run read, with its address, time, title and text, `truncated` when cut at a bound.
- **Document**: a PDF, text or Markdown file of the company's own that an engineer gives the script `pnpm knowledge:draft` with a Draft; the drafter reads its text after the pages, and a value from it cites `document:<name>`, shown as the name.
- **Stuck run**: a run still `fetching` or `fetched` with the record unchanged for more than ten minutes; the screen stops asking for the record and offers Draft again (docs/runbook.md).
- **Last change**: the field source written last, its time and its kind, which the screen shows as "Last changed … by …".
- **Version**: 1 when the record is created, one more with every save that changes it; `onboarding.company_knowledge_updated` carries it.
