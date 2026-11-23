// The frame of a research source's run (README.md "Runs"; docs/flows.md; gamma-wr-030): its first step,
// in the activity's own tenant run. The steps of the research come with gamma-wr-040 and after; this
// one starts the run as every run starts (domain/runs.ts openRun) and reads its audience, which says
// whether there is a country to look in. No account, no quota day, no read budget.
import { audienceOf } from "../agents.ts";
import { openRun, type RunRef } from "../runs.ts";

export type ResearchStart =
  | { readonly status: "gone" }
  | {
      readonly status: "started";
      /** The agent the source is in now, read once here; none for no agent. */
      readonly playbookId?: string;
      /** The countries of the run's audience, a count: none, and the run ends research_no_country. */
      readonly countries: number;
    };

/**
 * The first step of `signals_research_run`: the run `running` with the id of its workflow, the
 * source's last_run_at now; `gone` for a source gone, a stop asked before the start or a paused
 * agent, which end the run as every run ends them (openRun). Else the run's audience, its agent's or
 * the workspace's default (audienceOf), and how many countries it names. The history holds a count,
 * never the audience.
 */
export async function startResearchRun(
  ref: RunRef,
  workflowId: string,
  now = new Date(),
): Promise<ResearchStart> {
  const opened = await openRun(ref, workflowId, now);
  if (opened.status === "gone") return opened;
  const { agent } = opened;
  const inAgent = agent === null ? {} : { playbookId: agent.id };
  const { icp } = await audienceOf(ref.workspaceId, agent?.id);
  return { status: "started", ...inAgent, countries: icp.countries.length };
}
