/**
 * What a token costs, and how to say a number of them out loud.
 *
 * This is deliberately vendor-flavoured data — model ids and USD rates — but
 * it is pure: no network, no keys, no request shapes. It sits beside the
 * provider rather than inside it so the UI can import the same formatters the
 * server uses, and so a price change is a one-line edit in one place.
 */

/**
 * @typedef {{ inputPerMillion: number, outputPerMillion: number, contextWindow: number, maxOutput: number }} ModelPricing
 * @typedef {{ inputCost: number | null, outputCost: number | null, totalCost: number | null }} Cost
 */

/** Published USD prices per million tokens. @type {Record<string, ModelPricing>} */
export const PRICING = {
  "claude-haiku-4-5-20251001": {
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    contextWindow: 200000,
    maxOutput: 64000,
  },
};

/**
 * What one turn cost, in USD.
 *
 * An unknown model id is not an error: we still know how many tokens moved,
 * we just cannot price them. Every field comes back null in that case so the
 * UI can show counts without a price instead of crashing or inventing one.
 *
 * @param {{ model?: string, inputTokens?: number | null, outputTokens?: number | null }} params
 * @returns {Cost}
 */
export function estimateCost({ model, inputTokens, outputTokens } = {}) {
  const rates = PRICING[model];
  if (!rates) return { inputCost: null, outputCost: null, totalCost: null };

  const inputCost = perMillion(inputTokens, rates.inputPerMillion);
  const outputCost = perMillion(outputTokens, rates.outputPerMillion);
  if (inputCost === null && outputCost === null) {
    return { inputCost: null, outputCost: null, totalCost: null };
  }

  return {
    inputCost,
    outputCost,
    totalCost: (inputCost ?? 0) + (outputCost ?? 0),
  };
}

/** Whatever we know about a model, or null if we have never heard of it. */
export function pricingFor(model) {
  return PRICING[model] ?? null;
}

/**
 * Money, without the lie that a fraction of a cent is nothing. Rounding a
 * per-turn cost to two decimals would print `$0.00` for every single turn of
 * this app, which is exactly the number the challenge is asking us to show.
 *
 * @param {number | null | undefined} usd
 * @returns {string} e.g. `$0.0023`, `$1.24`, or `—` when unpriced.
 */
export function formatCost(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.0000";
  return usd < 0.01 ? "$" + usd.toFixed(4) : "$" + usd.toFixed(2);
}

/**
 * Token counts, kept readable at every magnitude: exact with separators while
 * the exact figure still means something, compact once it stops.
 *
 * @param {number | null | undefined} n
 * @returns {string} e.g. `8,432`, `12.4K`, `1.2M`, or `—`.
 */
export function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n);
  if (Math.abs(rounded) < 10000) return rounded.toLocaleString("en-US");
  if (Math.abs(rounded) < 1000000) return trim(rounded / 1000) + "K";
  return trim(rounded / 1000000) + "M";
}

function perMillion(tokens, rate) {
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return null;
  return (tokens / 1000000) * rate;
}

/** `12.4` but also `13`, not `13.0`. */
function trim(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}
