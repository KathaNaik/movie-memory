/**
 * Sends the browser to the sign-in page after the session ended (expired, or
 * signed out in another tab).
 */
export function redirectToSignIn() {
  // Deliberately a full page load rather than router.push(): it discards all
  // client state and Next's client router cache, which may still hold the
  // signed-out user's private data.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/?error=SessionExpired");
}
