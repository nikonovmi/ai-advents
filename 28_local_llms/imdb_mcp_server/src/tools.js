import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import pkg from "../package.json" with { type: "json" };
import { normalizeMovie, normalizeSearch } from "./normalize.js";
import { TOP500 } from "./top500.js";

/**
 * **The three tools, and the one place they are registered.**
 *
 * Handlers are plain functions of `(input, omdb)` so the tests can call them
 * without a transport; `createServer` wraps them for MCP. A handler either
 * returns data or throws, and `toolResult` is the only place either becomes a
 * `CallToolResult`: the data as JSON text plus `structuredContent`, an error as
 * `isError: true` with a sentence in it. Nothing a tool does crashes the
 * server. Every tool declares an `outputSchema`, and its `structuredContent`
 * is exactly that shape.
 */

const IMDB_ID = /^tt\d{7,10}$/;

export const searchMoviesInput = z.object({
  query: z.string().trim().min(1).describe("Words from the title, e.g. \"matrix\" or \"the godfather\". Title search only — not actors, plots or genres."),
  year: z.number().int().min(1870).max(2100).optional().describe("Only titles released in this year."),
  type: z.enum(["movie", "series", "episode"]).optional().describe("Restrict to one kind of title."),
  page: z.number().int().min(1).max(100).optional().describe("Result page, 1-100; each page has up to 10 hits. Default 1."),
});

export const getMovieInput = z
  .object({
    imdbId: z.string().trim().regex(IMDB_ID, "an IMDb id looks like tt0133093").optional().describe("IMDb id such as \"tt0133093\". Preferred when known (e.g. from search_movies): it is exact."),
    title: z.string().trim().min(1).optional().describe("Exact-ish title; OMDb returns its single best match. Add `year` to disambiguate remakes."),
    year: z.number().int().min(1870).max(2100).optional().describe("Release year, used with `title` only."),
    plot: z.enum(["short", "full"]).optional().describe("Plot length. Default \"short\"."),
  })
  .superRefine((input, ctx) => {
    const given = Number(Boolean(input.imdbId)) + Number(Boolean(input.title));
    if (given !== 1) {
      ctx.addIssue({ code: "custom", message: "Give exactly one of imdbId or title." });
    }
  });

export const randomMovieInput = z.object({});

// ---- what comes back ----------------------------------------------------------
// Declared so a client (the pipeline planner) knows the exact shape of each
// result before calling: which fields exist, and which may be null. The SDK
// checks every structuredContent against these before it leaves the server.

const text = z.string().nullable();

export const searchMoviesOutput = z.object({
  results: z
    .array(
      z.object({
        title: text.describe("Title as OMDb lists it."),
        year: text.describe('Year as a string: "2010", or a range like "2008–2013" for series.'),
        imdbId: text.describe('IMDb id, e.g. "tt1375666".'),
        type: text.describe('"movie", "series" or "episode".'),
      })
    )
    .describe("Up to 10 hits, best first."),
  totalResults: z.number().int().describe("How many hits OMDb has in all, across pages."),
});

export const movieOutput = z.object({
  title: text,
  year: text.describe("Release year, as a string."),
  runtimeMinutes: z.number().nullable().describe("Runtime in minutes, or null when unknown."),
  genres: z.array(z.string()),
  director: text,
  actors: z.array(z.string()),
  plot: text,
  imdbRating: z.number().nullable().describe("IMDb rating out of 10, or null when unrated."),
  ratings: z.array(z.object({ source: z.string(), value: z.string() })).describe("Ratings by source, as reported."),
  imdbId: text.describe('IMDb id, e.g. "tt1375666".'),
});

export const randomMovieOutput = movieOutput.extend({
  n: z.number().int().describe("Index of the pick in the 500-film list, 0-499."),
  pickedAt: z.string().describe("ISO time that chose the pick."),
});

export async function searchMovies(input, omdb) {
  const { query, year, type, page } = searchMoviesInput.parse(input);
  return normalizeSearch(await omdb.search({ query, year, type, page }));
}

export async function getMovie(input, omdb) {
  const { imdbId, title, year, plot = "short" } = getMovieInput.parse(input);
  const data = imdbId ? await omdb.byId(imdbId, { plot }) : await omdb.byTitle(title, { year, plot });
  return normalizeMovie(data);
}

/**
 * **Which film a moment picks.** n = hash(ms) % 500.
 *
 * A plain `ms % 500` would repeat: the scheduler ticks every 15 s, a multiple
 * of 500 ms, so every run would land on the same few films. A multiplicative
 * hash (Knuth's 2654435761, unsigned) spreads consecutive times out — but its
 * low bits only depend on the low bits of the input, and a 15 s step never
 * changes the bottom three, so `% 500` alone would still reach only a quarter
 * of the list. Folding the high half down first mixes every input bit into
 * the ones the modulo reads.
 *
 * @param {number} ms - Epoch milliseconds.
 */
export function pickIndex(ms, size = TOP500.length) {
  let hash = Math.imul(ms >>> 0, 2654435761);
  hash ^= hash >>> 16;
  return (hash >>> 0) % size;
}

/**
 * No input: the clock is the randomness, so the pick is reproducible from
 * `pickedAt` alone and a test can pin it by injecting `now`.
 */
export async function randomMovie(input, omdb, now = Date.now) {
  randomMovieInput.parse(input ?? {});
  const ms = now();
  const n = pickIndex(ms);
  const movie = await getMovie({ imdbId: TOP500[n].imdbId }, omdb);
  return { n, pickedAt: new Date(ms).toISOString(), ...movie };
}

/** Data or an error, as MCP wants it back. */
export async function toolResult(run) {
  try {
    const data = await run();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: readable(err) }],
      isError: true,
    };
  }
}

function readable(err) {
  if (err instanceof z.ZodError) {
    return "Invalid input: " + err.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message).join("; ");
  }
  return err?.message ?? String(err);
}

/**
 * A fresh server with the three tools on it. Stateless HTTP builds one per
 * request, which is cheap: registering three tools is a few object writes.
 *
 * @param {{ omdb: ReturnType<typeof import("./omdbClient.js").createOmdbClient>, now?: () => number }} deps -
 *   `now` is the clock `random_movie` picks by; injected by the tests.
 */
export function createServer({ omdb, now = Date.now }) {
  const server = new McpServer({ name: "omdb-mcp", version: pkg.version });

  server.registerTool(
    "search_movies",
    {
      title: "Search OMDb",
      description:
        "Search OMDb (the IMDb-backed Open Movie Database) by title words. Returns up to 10 matches as " +
        "{ title, year, imdbId, type } plus totalResults. Use it to find the imdbId of a title, or to " +
        "disambiguate remakes and series, then call get_movie with the imdbId for details. " +
        "It does not return runtimes, ratings or plots.",
      inputSchema: searchMoviesInput,
      outputSchema: searchMoviesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => toolResult(() => searchMovies(input, omdb))
  );

  server.registerTool(
    "get_movie",
    {
      title: "Get one movie",
      description:
        "Full details for exactly one title: title, year, runtimeMinutes (a number), genres[], director, " +
        "actors[], plot, imdbRating (a number out of 10, or null), ratings[] (IMDb, Rotten Tomatoes, " +
        "Metacritic as reported) and imdbId. Pass exactly one of imdbId (exact) or title (OMDb's best " +
        "match; add year for remakes). Use it for any factual question about runtime, rating, cast or plot " +
        "instead of answering from memory.",
      inputSchema: getMovieInput,
      outputSchema: movieOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => toolResult(() => getMovie(input, omdb))
  );

  server.registerTool(
    "random_movie",
    {
      title: "Random movie",
      description:
        "Pick a film from a list of 500 well-known, highly rated titles and return the same details as " +
        "get_movie, plus n (its index in the list, 0-499) and pickedAt (the time that chose it). No input: " +
        "the pick is derived from the current time, so two calls a few seconds apart differ. " +
        "Use it for \"suggest something to watch\" style requests.",
      inputSchema: randomMovieInput,
      outputSchema: randomMovieOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => toolResult(() => randomMovie(input, omdb, now))
  );

  return server;
}
