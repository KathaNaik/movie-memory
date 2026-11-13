import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OnboardingState } from "@/app/onboarding/actions";
import { OnboardingForm } from "@/app/onboarding/onboarding-form";

const { saveFavoriteMovie } = vi.hoisted(() => ({ saveFavoriteMovie: vi.fn() }));
vi.mock("@/app/onboarding/actions", () => ({ saveFavoriteMovie }));

function submit(title: string) {
  fireEvent.change(screen.getByLabelText("What is your favorite movie?"), {
    target: { value: title },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

beforeEach(() => {
  saveFavoriteMovie.mockReset();
});

describe("OnboardingForm", () => {
  it("submits the typed title to the server action", async () => {
    saveFavoriteMovie.mockResolvedValue({});
    render(<OnboardingForm />);

    await act(async () => submit("Jaws"));

    const formData: FormData = saveFavoriteMovie.mock.calls[0][1];
    expect(formData.get("favoriteMovie")).toBe("Jaws");
  });

  it("shows a pending state while saving", async () => {
    let resolve!: (state: OnboardingState) => void;
    saveFavoriteMovie.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<OnboardingForm />);

    await act(async () => submit("Jaws"));

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => resolve({}));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("shows the server's validation error and keeps the input", async () => {
    saveFavoriteMovie.mockResolvedValue({
      error: "Movie title must be at least 2 characters.",
      value: "A",
    });
    render(<OnboardingForm />);

    await act(async () => submit("A"));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Movie title must be at least 2 characters.",
    );
    const input = screen.getByLabelText("What is your favorite movie?");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveValue("A");
  });
});
