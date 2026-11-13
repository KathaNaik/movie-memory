import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DashboardPage from "@/app/dashboard/page";
import Home from "@/app/page";
import OnboardingPage from "@/app/onboarding/page";
import type { CurrentUser } from "@/lib/current-user";

import { expectRedirect } from "./helpers/navigation";

// External boundaries: the session/database lookup, Auth.js, and Next.js.
const { getCurrentUser } = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser }));
vi.mock("@/auth", () => ({ signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() }));
vi.mock("next/navigation", async () => {
  const { mockRedirect } = await import("./helpers/navigation");
  return { redirect: vi.fn(mockRedirect) };
});
vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string; onError?: () => void }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt} onError={props.onError} />
  ),
}));
vi.mock("@/app/onboarding/actions", () => ({ saveFavoriteMovie: vi.fn() }));
// The dashboard's client component requests a fact on mount; keep it pending.
vi.mock("@/lib/api", () => ({
  getMovieFact: vi.fn(() => new Promise(() => {})),
  updateFavoriteMovie: vi.fn(),
  ApiClientError: class extends Error {},
}));

const newUser: CurrentUser = {
  id: "user_1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  image: "https://lh3.googleusercontent.com/a/photo",
  favoriteMovie: null,
};
const returningUser: CurrentUser = { ...newUser, favoriteMovie: "Spirited Away" };

/** Props for the landing page, which reads ?error= from the URL. */
function homeProps(searchParams: Record<string, string> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) };
}

beforeEach(() => {
  getCurrentUser.mockReset();
});

describe("/ (landing)", () => {
  it("shows the sign-in button to signed-out visitors", async () => {
    getCurrentUser.mockResolvedValue(null);

    render(await Home(homeProps()));

    expect(screen.getByRole("heading", { level: 1, name: "Movie Memory" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains an expired session", async () => {
    getCurrentUser.mockResolvedValue(null);

    render(await Home(homeProps({ error: "SessionExpired" })));

    expect(screen.getByRole("alert")).toHaveTextContent("Your session has expired. Please sign in again.");
  });

  it("shows a friendly message for Auth.js errors, never the raw code", async () => {
    getCurrentUser.mockResolvedValue(null);

    // What a cancelled Google consent screen produces.
    render(await Home(homeProps({ error: "Configuration<script>" })));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Sign-in didn't complete. If you cancelled, no problem.");
    expect(alert).not.toHaveTextContent("Configuration");
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("sends first-time users to onboarding", async () => {
    getCurrentUser.mockResolvedValue(newUser);
    await expectRedirect(Home(homeProps()), "/onboarding");
  });

  it("sends returning users to the dashboard", async () => {
    getCurrentUser.mockResolvedValue(returningUser);
    await expectRedirect(Home(homeProps()), "/dashboard");
  });
});

describe("/onboarding", () => {
  it("redirects signed-out visitors to sign in", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expectRedirect(OnboardingPage(), "/");
  });

  it("redirects already-onboarded users to the dashboard", async () => {
    getCurrentUser.mockResolvedValue(returningUser);
    await expectRedirect(OnboardingPage(), "/dashboard");
  });

  it("shows the question to first-time users", async () => {
    getCurrentUser.mockResolvedValue(newUser);

    render(await OnboardingPage());

    expect(screen.getByLabelText("What is your favorite movie?")).toBeInTheDocument();
  });
});

describe("/dashboard", () => {
  it("redirects signed-out visitors to sign in", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expectRedirect(DashboardPage(), "/");
  });

  it("redirects users who haven't onboarded to onboarding", async () => {
    getCurrentUser.mockResolvedValue(newUser);
    await expectRedirect(DashboardPage(), "/onboarding");
  });

  it("shows the profile and favorite movie from the database", async () => {
    getCurrentUser.mockResolvedValue(returningUser);

    const { container } = render(await DashboardPage());

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("Spirited Away")).toBeInTheDocument();
    // The profile photo (the page also renders the decorative backdrop image).
    expect(container.querySelector(`img[src="${returningUser.image}"]`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("falls back to the email and an initial when name and photo are missing", async () => {
    getCurrentUser.mockResolvedValue({ ...returningUser, name: null, image: null });

    const { container } = render(await DashboardPage());

    expect(screen.getAllByText("ada@example.com")).toHaveLength(2);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(container.querySelector('img[src^="https://lh3.googleusercontent.com"]')).toBeNull();
  });

  it("falls back to the initial when the photo fails to load", async () => {
    getCurrentUser.mockResolvedValue(returningUser);

    const { container } = render(await DashboardPage());
    fireEvent.error(container.querySelector(`img[src="${returningUser.image}"]`)!);

    expect(container.querySelector(`img[src="${returningUser.image}"]`)).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});
