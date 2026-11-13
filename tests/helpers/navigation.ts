// next/navigation's redirect() throws to stop rendering. The mock does the same
// with an error that records the target, so tests can assert on it.
export class RedirectError extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

export function mockRedirect(url: string): never {
  throw new RedirectError(url);
}

export async function expectRedirect(promise: Promise<unknown>, url: string) {
  const error = await promise.then(
    () => {
      throw new Error(`Expected redirect to ${url}, but nothing redirected`);
    },
    (e: unknown) => e,
  );
  if (!(error instanceof RedirectError)) throw error;
  if (error.url !== url) {
    throw new Error(`Expected redirect to ${url}, got ${error.url}`);
  }
}
