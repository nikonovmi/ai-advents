/**
 * **The pool `random_movie` draws from.**
 *
 * OMDb has no random endpoint and no way to list by genre, so the pool is a
 * hand-picked list of well-known titles. The genre tags are ours and only used
 * to filter the pool before anything is fetched; the genres in the answer
 * always come from OMDb.
 */
export const CURATED = [
  { imdbId: "tt0111161", title: "The Shawshank Redemption", genres: ["drama"] },
  { imdbId: "tt0068646", title: "The Godfather", genres: ["crime", "drama"] },
  { imdbId: "tt0468569", title: "The Dark Knight", genres: ["action", "crime", "drama"] },
  { imdbId: "tt0110912", title: "Pulp Fiction", genres: ["crime", "drama"] },
  { imdbId: "tt0137523", title: "Fight Club", genres: ["drama"] },
  { imdbId: "tt1375666", title: "Inception", genres: ["action", "adventure", "sci-fi"] },
  { imdbId: "tt0133093", title: "The Matrix", genres: ["action", "sci-fi"] },
  { imdbId: "tt0109830", title: "Forrest Gump", genres: ["drama", "romance"] },
  { imdbId: "tt0816692", title: "Interstellar", genres: ["adventure", "drama", "sci-fi"] },
  { imdbId: "tt0120737", title: "The Lord of the Rings: The Fellowship of the Ring", genres: ["adventure", "drama", "fantasy"] },
  { imdbId: "tt0167260", title: "The Lord of the Rings: The Return of the King", genres: ["adventure", "drama", "fantasy"] },
  { imdbId: "tt0076759", title: "Star Wars: Episode IV - A New Hope", genres: ["action", "adventure", "fantasy", "sci-fi"] },
  { imdbId: "tt0080684", title: "Star Wars: Episode V - The Empire Strikes Back", genres: ["action", "adventure", "fantasy", "sci-fi"] },
  { imdbId: "tt0114369", title: "Seven", genres: ["crime", "drama", "mystery", "thriller"] },
  { imdbId: "tt0102926", title: "The Silence of the Lambs", genres: ["crime", "drama", "thriller", "horror"] },
  { imdbId: "tt0245429", title: "Spirited Away", genres: ["animation", "adventure", "family", "fantasy"] },
  { imdbId: "tt0110357", title: "The Lion King", genres: ["animation", "adventure", "drama", "family"] },
  { imdbId: "tt0114709", title: "Toy Story", genres: ["animation", "adventure", "comedy", "family"] },
  { imdbId: "tt0088763", title: "Back to the Future", genres: ["adventure", "comedy", "sci-fi"] },
  { imdbId: "tt0081505", title: "The Shining", genres: ["drama", "horror"] },
  { imdbId: "tt0078748", title: "Alien", genres: ["horror", "sci-fi"] },
  { imdbId: "tt0054215", title: "Psycho", genres: ["horror", "mystery", "thriller"] },
  { imdbId: "tt0107290", title: "Jurassic Park", genres: ["action", "adventure", "sci-fi"] },
  { imdbId: "tt0118799", title: "Life Is Beautiful", genres: ["comedy", "drama", "romance", "war"] },
  { imdbId: "tt0034583", title: "Casablanca", genres: ["drama", "romance", "war"] },
  { imdbId: "tt0120815", title: "Saving Private Ryan", genres: ["drama", "war"] },
  { imdbId: "tt0172495", title: "Gladiator", genres: ["action", "adventure", "drama"] },
  { imdbId: "tt0482571", title: "The Prestige", genres: ["drama", "mystery", "sci-fi", "thriller"] },
  { imdbId: "tt0209144", title: "Memento", genres: ["mystery", "thriller"] },
  { imdbId: "tt0118715", title: "The Big Lebowski", genres: ["comedy", "crime"] },
  { imdbId: "tt0116282", title: "Fargo", genres: ["comedy", "crime", "drama", "thriller"] },
  { imdbId: "tt6751668", title: "Parasite", genres: ["comedy", "drama", "thriller"] },
];

/** Every tag in the pool, for the error that names what a genre could be. */
export const CURATED_GENRES = [...new Set(CURATED.flatMap((movie) => movie.genres))].sort();

/** @param {string} [genre] */
export function curatedPool(genre) {
  if (!genre) return CURATED;
  const wanted = genre.trim().toLowerCase().replace(/\s+/g, "-").replace(/^scifi$|^science-fiction$/, "sci-fi");
  return CURATED.filter((movie) => movie.genres.includes(wanted));
}
