/**
 * **OMDb's shapes, turned into ours.**
 *
 * OMDb answers in PascalCase strings: `"148 min"`, `"8.8"`, `"N/A"`,
 * `"Action, Adventure"`. What a tool returns is camelCase with real types —
 * numbers where the value is a number, arrays where it is a list, and `null`
 * where OMDb says `"N/A"` — so the model never has to parse a string to compare
 * two runtimes.
 */

/** OMDb's placeholder for "nothing here". */
function present(value) {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim();
  return trimmed && trimmed !== "N/A" ? trimmed : null;
}

/** `"148 min"` → 148; `"N/A"` → null. */
export function parseRuntime(value) {
  const text = present(value);
  if (!text) return null;
  const match = /(\d+)\s*min/i.exec(text) ?? /^(\d+)$/.exec(text);
  return match ? Number(match[1]) : null;
}

/** `"8.8"` → 8.8; `"N/A"` → null. */
export function parseRating(value) {
  const text = present(value);
  if (!text) return null;
  const number = Number(text.replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

/** `"Action, Adventure"` → ["Action", "Adventure"]; `"N/A"` → []. */
export function splitList(value) {
  const text = present(value);
  if (!text) return [];
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

/** One search hit. */
export function normalizeSearchItem(item) {
  return {
    title: present(item?.Title),
    year: present(item?.Year),
    imdbId: present(item?.imdbID),
    type: present(item?.Type),
  };
}

/** A search page: at most ten hits, plus how many OMDb says there are. */
export function normalizeSearch(data) {
  const results = (Array.isArray(data?.Search) ? data.Search : []).slice(0, 10).map(normalizeSearchItem);
  const total = Number(data?.totalResults);
  return { results, totalResults: Number.isFinite(total) ? total : results.length };
}

/** One title, in full. */
export function normalizeMovie(data) {
  return {
    title: present(data?.Title),
    year: present(data?.Year),
    runtimeMinutes: parseRuntime(data?.Runtime),
    genres: splitList(data?.Genre),
    director: present(data?.Director),
    actors: splitList(data?.Actors),
    plot: present(data?.Plot),
    imdbRating: parseRating(data?.imdbRating),
    ratings: (Array.isArray(data?.Ratings) ? data.Ratings : [])
      .map((rating) => ({ source: present(rating?.Source), value: present(rating?.Value) }))
      .filter((rating) => rating.source && rating.value),
    imdbId: present(data?.imdbID),
  };
}
