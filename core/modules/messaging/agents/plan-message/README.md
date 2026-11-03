# messaging.plan-message

The planner (alpha-p9-020), the first of the writer's two calls (F09 §5.1): from the dossier, the angle, the facts and the call to action of one first LinkedIn message. [docs/flows.md](../../docs/flows.md) says how a draft is made, [docs/security.md](../../docs/security.md) what the model sees.

- **Task:** `task.ts`: `kind: generation`, no tools, prompt version 1, a budget of 8,000 input tokens, 500 output tokens and 0 credits (not priced in alpha; the wrapper's cost event records the call). The model is `AI_MODEL_MESSAGING_PLAN_MESSAGE`, else the LLM port's first. The module never imports the file: `writeDraft` takes the task from the agent registry.
- **Prompt:** `prompt.v1.md`. The blocks, in order: `<channel>`, `<dossier>` (the sender and the offer), `<lead>` (with their company) and `<why_now>` (both untrusted, the third line of the header says so), `<failures>` and `<replaced>` (`domain/drafts/blocks.ts` builds them; `schemas/writer.ts`). Once drafts have run on it, a changed prompt is `prompt.v2.md` with `promptVersion: 2`, and runs the evals.
- **Output:** `angle` (`signal_comment`, `signal_reaction`, `pain_point`, `proof_point`), `factIds` (one to eight), `cta` (`question`, `soft_ask`, `resource`). The module's gate `facts_used` checks the ids against the blocks the planner read, after the call.
- **Evals:** `core/packages/ai/evals/messaging.plan-message/`, ten synthetic leads; `outcome` and `angle` pass when the plan cites only the case's facts with the expected angle (`pnpm -F ai eval messaging`).
