// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateMovieFact, MAX_FACT_LENGTH, MovieNotRecognizedError } from "@/lib/openai";

const { parse, constructorOptions } = vi.hoisted(() => ({
  parse: vi.fn(),
  constructorOptions: [] as unknown[],
}));
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse };
    constructor(options: unknown) {
      constructorOptions.push(options);
    }
  },
}));

// Shape of a Responses API result after the SDK parsed the structured output.
function modelReturns(
  output: { recognized: boolean; identifiedTitle: string | null; fact: string | null } | null,
  status = "completed",
) {
  parse.mockResolvedValue({ status, output_parsed: output });
}

beforeEach(() => {
  parse.mockReset();
  vi.stubEnv("OPENAI_MODEL", "test-model");
});

describe("generateMovieFact", () => {
  it("returns the fact and identified film when the model recognizes a shortened title", async () => {
    modelReturns({
      recognized: true,
      identifiedTitle: "Barbie: Princess Charm School (2011)",
      fact: "  Barbie: Princess Charm School is set at a school for princesses.  ",
    });

    await expect(generateMovieFact("Barbie charm school")).resolves.toEqual({
      fact: "Barbie: Princess Charm School is set at a school for princesses.",
      identifiedTitle: "Barbie: Princess Charm School (2011)",
    });

    // The user's title goes to the configured model as-is, with a strict JSON schema.
    const request = parse.mock.calls[0][0];
    expect(request.model).toBe("test-model");
    expect(JSON.parse(request.input)).toEqual({ title: "Barbie charm school", alreadyShared: [] });
    expect(request.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(constructorOptions[0]).toEqual({ timeout: 15_000, maxRetries: 1 });
  });

  it("sends previously shown facts alongside the title", async () => {
    modelReturns({ recognized: true, identifiedTitle: "Jaws (1975)", fact: "A new fact." });

    await generateMovieFact("Jaws", ["The shark was nicknamed Bruce."]);

    expect(JSON.parse(parse.mock.calls[0][0].input)).toEqual({
      title: "Jaws",
      alreadyShared: ["The shark was nicknamed Bruce."],
    });
  });

  it("throws MovieNotRecognizedError when the model can't identify the film", async () => {
    modelReturns({ recognized: false, identifiedTitle: null, fact: null });

    await expect(generateMovieFact("Zorblax Moonquest Returns")).rejects.toBeInstanceOf(
      MovieNotRecognizedError,
    );
  });

  it("treats 'recognized' without a usable fact as not recognized", async () => {
    modelReturns({ recognized: true, identifiedTitle: "Something (2001)", fact: "   " });

    await expect(generateMovieFact("Something")).rejects.toBeInstanceOf(MovieNotRecognizedError);
  });

  it("rejects facts longer than the limit instead of storing them", async () => {
    modelReturns({ recognized: true, identifiedTitle: "Jaws (1975)", fact: "x".repeat(MAX_FACT_LENGTH + 1) });
    const tooLong = generateMovieFact("Jaws");
    await expect(tooLong).rejects.toThrow("too long");
    await expect(tooLong).rejects.not.toBeInstanceOf(MovieNotRecognizedError);

    modelReturns({ recognized: true, identifiedTitle: "Jaws (1975)", fact: "x".repeat(MAX_FACT_LENGTH) });
    await expect(generateMovieFact("Jaws")).resolves.toMatchObject({ fact: "x".repeat(MAX_FACT_LENGTH) });
  });

  it("returns a null identified title when the model leaves it blank", async () => {
    modelReturns({ recognized: true, identifiedTitle: "   ", fact: "A fact." });

    await expect(generateMovieFact("Jaws")).resolves.toEqual({ fact: "A fact.", identifiedTitle: null });
  });

  it("fails generically on refusals and truncated output", async () => {
    // A refusal has no parsed output.
    modelReturns(null);
    const refusal = generateMovieFact("Jaws");
    await expect(refusal).rejects.toThrow("OpenAI response unusable");
    await expect(refusal).rejects.not.toBeInstanceOf(MovieNotRecognizedError);

    // Cut off by the token limit.
    modelReturns({ recognized: true, identifiedTitle: "Jaws (1975)", fact: "Half a" }, "incomplete");
    await expect(generateMovieFact("Jaws")).rejects.toThrow("OpenAI response unusable");
  });

  it("fails when OPENAI_MODEL is missing", async () => {
    vi.stubEnv("OPENAI_MODEL", "");

    await expect(generateMovieFact("Jaws")).rejects.toThrow("OPENAI_MODEL is not set");
    expect(parse).not.toHaveBeenCalled();
  });
});
