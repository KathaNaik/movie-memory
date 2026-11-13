import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// `server-only` throws outside a React Server Components build; server modules
// are imported directly in tests.
vi.mock("server-only", () => ({}));

// Vitest globals are disabled, so React Testing Library can't register its
// automatic cleanup; unmount rendered trees between tests explicitly.
afterEach(() => {
  cleanup();
});
