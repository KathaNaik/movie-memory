# How I used AI

[← Back to README](../README.md)

- I used Claude Code as a pair programmer throughout: scaffolding, writing code and tests, and running checks.
- I worked in milestones (setup, sign-in and onboarding, API, dashboard, hardening), wrote the requirements for each, and reviewed the output before moving on. I made the design calls myself, for example choosing Variant B, which extra safeguards to add, using `sessionStorage` for the cache, and the visual design.
- I had it check against the real services, not just mocks: read-only Neon queries before and after migrations, a few deliberate OpenAI calls when tuning the prompt, and HTTP checks of redirects and status codes.
- I used checklists of edge cases (authentication, onboarding, caching, race conditions) to review the app. That turned up real problems, which we then fixed and tested, such as a possible account lockout and a database outage that looked like being logged out.
- To make sure key tests could actually fail, I had it temporarily remove the code each test protects and confirm the test failed.
- I tested in the browser myself with several Google accounts, and supplied the artwork and design feedback through screenshots.
- Not everything it produced was right first time. A loading screen broke the server redirect, the first prompt mixed up two Barbie films, and early facts repeated the same point in different words. Each was caught in testing and fixed.
