# messaging.write-message

The writer (alpha-p9-020), the second of the two calls (F09 §5.1): the text of one first LinkedIn message, from the dossier and the plan. [docs/flows.md](../../docs/flows.md) says how a draft is made, [docs/security.md](../../docs/security.md) what the model sees and the gates.

- **Task:** `task.ts`: `kind: generation`, no tools, prompt version 1, a budget of 8,000 input tokens, 1,500 output tokens and 0 credits (not priced in alpha). The model is `AI_MODEL_MESSAGING_WRITE_MESSAGE`, else the LLM port's first. The module never imports the file: `writeDraft` takes the task from the agent registry.
- **Prompt:** `prompt.v1.md`. The planner's blocks plus `<plan>`, before `<failures>` and `<replaced>`. Once drafts have run on it, a changed prompt is `prompt.v2.md` with `promptVersion: 2`, and runs the evals.
- **Output:** `text`, 1 to 4,000 characters. The module's gates check it after the call: `placeholders`, `length`, `grounding`, `red_lines` (`domain/gates/`).
- **Evals:** `core/packages/ai/evals/messaging.write-message/`, twenty synthetic dossiers on two sellers; the scorer runs the gates in short after every answer, then checks the text's length against `<channel>`, no red-line phrase, its grounding (every name and number in a fact, 0.9), the words the case expects, and that three injections in the evidence fail safe (`pnpm -F ai eval messaging`).
