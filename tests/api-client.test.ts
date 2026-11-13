import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, getMe, getMovieFact, updateFavoriteMovie } from "@/lib/api";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function caught(promise: Promise<unknown>): Promise<ApiClientError> {
  const error = await promise.then(
    () => {
      throw new Error("Expected the call to fail");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiClientError);
  return error as ApiClientError;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client", () => {
  it("parses a successful typed response", async () => {
    const me = { id: "u1", name: null, email: "a@b.co", image: null, favoriteMovie: "Jaws" };
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: me }));

    await expect(getMe()).resolves.toEqual(me);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("parses a fact with an ISO timestamp", async () => {
    const fact = {
      id: "f1",
      content: "Fact.",
      movieTitle: "Jaws",
      identifiedTitle: "Jaws (1975)",
      createdAt: "2026-11-13T10:00:00.000Z",
    };
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: fact }));

    await expect(getMovieFact()).resolves.toEqual(fact);
  });

  it("sends the movie as JSON with a PUT", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { favoriteMovie: "Alien" } }));

    await expect(updateFavoriteMovie("Alien")).resolves.toEqual({ favoriteMovie: "Alien" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/me/movie");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(JSON.stringify({ movie: "Alien" }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("surfaces the server's 401 error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: "UNAUTHENTICATED", message: "You need to sign in to do that." } },
        401,
      ),
    );

    const error = await caught(getMe());

    expect(error).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
      message: "You need to sign in to do that.",
    });
  });

  it("surfaces the server's 400 validation message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: "INVALID_INPUT", message: "Movie title must be at least 2 characters." } },
        400,
      ),
    );

    const error = await caught(updateFavoriteMovie("A"));

    expect(error).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(error.message).toBe("Movie title must be at least 2 characters.");
  });

  it("normalizes a 500 with a non-JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Internal Server Error</html>", { status: 500 }));

    const error = await caught(getMovieFact());

    expect(error).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });

  it("normalizes a 401 with an empty body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const error = await caught(getMe());

    expect(error).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("rejects malformed JSON on a 200", async () => {
    fetchMock.mockResolvedValue(new Response("{oops", { status: 200 }));

    const error = await caught(getMe());

    expect(error).toMatchObject({ status: 200, code: "INVALID_RESPONSE" });
  });

  it.each([
    ["no envelope", { id: "u1" }],
    ["wrong data shape", { success: true, data: { id: 1 } }],
    ["missing data", { success: true }],
    ["bad timestamp", { success: true, data: { id: "f1", content: "x", movieTitle: "y", identifiedTitle: null, createdAt: "yesterday" } }],
    ["missing identifiedTitle", { success: true, data: { id: "f1", content: "x", movieTitle: "y", createdAt: "2026-11-13T10:00:00.000Z" } }],
  ])("rejects an unexpected body (%s)", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    const error = await caught(getMovieFact());

    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("normalizes a 403 without a JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));

    const error = await caught(getMe());

    expect(error).toMatchObject({ status: 403, code: "FORBIDDEN", message: "You don't have permission to do that." });
  });

  it("gives every request a timeout, longer for fact generation", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { favoriteMovie: "Alien" } }));
    await updateFavoriteMovie("Alien");
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: { code: "X", message: "x" } }, 500));
    await getMe().catch(() => {});
    await getMovieFact().catch(() => {});
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([15_000, 80_000]);
    timeout.mockRestore();
  });

  it("normalizes a timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    const error = await caught(getMovieFact());

    expect(error).toMatchObject({ status: 0, code: "TIMEOUT" });
  });

  it("normalizes a timeout while reading the body", async () => {
    const response = jsonResponse({ success: true, data: {} });
    vi.spyOn(response, "json").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    fetchMock.mockResolvedValue(response);

    const error = await caught(getMe());

    expect(error).toMatchObject({ status: 0, code: "TIMEOUT" });
  });

  it("normalizes network failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await caught(getMe());

    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });
});
