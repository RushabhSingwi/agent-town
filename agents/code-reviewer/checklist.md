# Review checklist

## Correctness
- Does every new branch handle the empty / missing / error case?
- Are errors raised or returned, not silently swallowed (bare `except`, empty `catch`)?
- Loops: off-by-one, mutation while iterating, termination.
- Dates and times: time zones, daylight saving, inclusive vs exclusive ranges.
- Money and counts: integers or decimals, never floats for currency.
- Concurrency: shared state, two requests at once, retries that double-apply.

## Security
- User input reaching SQL, shell, file paths, HTML or URLs without escaping or validation.
- Authorization: can user A read or change user B's data through this path?
- Secrets, tokens or keys committed in code, logs or error messages.
- New dependencies: maintained, licensed, actually needed?

## Data
- Migrations: reversible? Do they lock a big table? Defaults for existing rows?
- Deletes: soft or hard? Cascades that remove more than intended?

## APIs
- Breaking changes to request/response shapes, status codes or URLs.
- Pagination and limits on anything that can grow.

## Tests
- Is the changed behaviour tested, including the failure path?
- Do the tests assert outcomes, not just that code ran?
