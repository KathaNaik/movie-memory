import { describe, expect, it } from "vitest";

import { parseMovieTitle } from "@/lib/validation/movie";

describe("parseMovieTitle", () => {
  it("accepts a valid title and trims surrounding whitespace", () => {
    expect(parseMovieTitle("  The Matrix  ")).toEqual({
      success: true,
      movieTitle: "The Matrix",
    });
  });

  it.each(["千と千尋の神隠し", "Amélie", "Ōkami", "La La Land 🎬", `"Weird" Al's <Movie>; DROP TABLE "User";--`])(
    "accepts Unicode, quotes and SQL-like text as plain data: %s",
    (title) => {
      expect(parseMovieTitle(`  ${title}  `)).toEqual({ success: true, movieTitle: title });
    },
  );

  it("accepts titles at the 2 and 100 character bounds", () => {
    expect(parseMovieTitle("Up")).toEqual({ success: true, movieTitle: "Up" });
    expect(parseMovieTitle("a".repeat(100)).success).toBe(true);
  });

  it("rejects titles shorter than 2 characters after trimming", () => {
    expect(parseMovieTitle("   A   ")).toEqual({
      success: false,
      error: "Movie title must be at least 2 characters.",
    });
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseMovieTitle("").success).toBe(false);
    expect(parseMovieTitle("     ").success).toBe(false);
  });

  it("rejects titles longer than 100 characters", () => {
    expect(parseMovieTitle("a".repeat(101))).toEqual({
      success: false,
      error: "Movie title must be at most 100 characters.",
    });
  });

  it.each([null, undefined, 42, {}, ["Jaws"]])("rejects non-string input %j", (input) => {
    expect(parseMovieTitle(input)).toEqual({
      success: false,
      error: "Please enter a movie title.",
    });
  });
});
