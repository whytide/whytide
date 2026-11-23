// The LLM fake's price table as COST_PRICES_JSON, for a test file whose code calls the model with
// no table of its own, as the worker runs the batch's assessLead: imported first, before platform's
// config reads the variable. A table the environment already sets wins.
process.env.COST_PRICES_JSON ??= JSON.stringify({
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
});
