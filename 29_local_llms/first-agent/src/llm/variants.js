/**
 * **The Day 29 optimization variants**: what `eval:local -- --variant` and
 * `verify:local -- --variant` run, as environment overrides on top of `.env`.
 *
 * | variant | num_ctx (all calls) | prompts |
 * | --- | --- | --- |
 * | `baseline` | 16384 RAG / 8192 plain (Day 28's settings) | v1 |
 * | `ctx8k` | 8192 | v1 |
 * | `ctx8k+prompt` | 8192 | v2 |
 *
 * Experiment 1 is `ctx8k` against `baseline` (a parameter: one window for every
 * local call, so the model loads once and stays loaded). Experiment 2 is
 * `ctx8k+prompt` against `ctx8k` (the prompt template, on top of it).
 */

export const OPT_VARIANTS = [
  {
    id: "baseline",
    label: "baseline",
    description: "Day 28's settings: num_ctx 16384 for RAG calls, 8192 for plain chat; v1 prompts",
    env: { LOCAL_NUM_CTX: "8192", LOCAL_RAG_NUM_CTX: "16384", LOCAL_PROMPT_VARIANT: "v1" },
  },
  {
    id: "ctx8k",
    label: "ctx8k",
    description: "Experiment 1: num_ctx 8192 on every local call; v1 prompts",
    env: { LOCAL_NUM_CTX: "8192", LOCAL_RAG_NUM_CTX: "8192", LOCAL_PROMPT_VARIANT: "v1" },
  },
  {
    id: "ctx8k+prompt",
    label: "ctx8k+prompt",
    description: "Experiment 2, on top of 1: num_ctx 8192 everywhere; v2 contract and router prompts",
    env: { LOCAL_NUM_CTX: "8192", LOCAL_RAG_NUM_CTX: "8192", LOCAL_PROMPT_VARIANT: "v2" },
  },
];

export const OPT_VARIANT_IDS = OPT_VARIANTS.map((v) => v.id);

/** A variant by id, or a readable error listing the ids. */
export function optVariant(id) {
  const variant = OPT_VARIANTS.find((v) => v.id === id);
  if (!variant) throw new Error(`--variant must be one of ${OPT_VARIANT_IDS.join(", ")}, got "${id}"`);
  return variant;
}

/** `env` with the variant's settings on top: the variant wins over `.env`. */
export function variantEnv(id, env = process.env) {
  return { ...env, ...optVariant(id).env };
}

/** A file-name-safe id: `ctx8k+prompt` → `ctx8k-prompt`. */
export const variantSlug = (id) => String(id).replace(/[^a-z0-9]+/gi, "-");
