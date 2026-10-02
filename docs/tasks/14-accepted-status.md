# 14: Status "accepted" for jobs the user holds

## Why
A job search does not always end with the first offer. A user may accept an offer, start working, and keep searching for a better or longer-term role. Today CometScout has no status for that. An accepted offer stays at `offer`, so the coach hand-off lists it under "in progress", and the Today screen and follow-ups treat it as an open process. The user is then reminded about a job they already hold, and the coach preps them for an interview loop that ended weeks ago.

Maintainer decision: add a status `accepted` (an offer the user took and now works in). `offer` keeps meaning an open offer.

Read `DEVELOPMENT.md` first. Plain Node 20, no new dependencies, synthetic data only, no em dashes in user-facing text. Every change gets a test; `npm test` must pass on Linux and Windows.

## 1. The status
- `lib/applications.mjs` `STATUSES` gains `accepted` (after `offer`). `cli.mjs status <company> accepted [role words] [--note ...]` works like the other statuses; update the usage line.
- The decoder treats `accepted` like the other closing statuses: it closes the role for picks and for dedupe (`CLOSED_STATUSES`, `STATUS_WORDS` in `decoder/decoder.mjs`).
- Outcomes from email never set `accepted`. An offer email still sets `offer`, and it never moves an application that is already `accepted` back to `offer` (or to any earlier status). Only the user sets `accepted`.
- Labels in `lib/i18n.mjs`: English "Accepted, working", Russian "Работаю здесь" (or a better short Russian label; keep it short enough for the status chip).

## 2. Where it shows
- **Coach hand-off (`lib/coach.mjs`):** a new section "Jobs I hold" under "Where I stand" (company, role, since: the date of the `accepted` event). These rows are left out of "in progress" and "Coming up". A future interview date on an accepted application is still listed under "Coming up" with a note, because it can be a probation review.
- **Today screen and workspace:** accepted roles never appear in follow-ups or in "waiting for reply". The status menu in the pack pane offers `accepted` next to `offer`. The counts strip shows "Working" when there is at least one.
- **Tracker export (`lib/tracker.mjs`):** `accepted` maps to stage `Offer`, furthest stage `Offer` (the tracker format has no hired stage). The note starts with "Accepted".
- **Scorecard:** an accepted application counts wherever an offer counts (it reached the offer stage).

## 3. Import and export
Export v2 and import carry the status as-is. Importing an archive with `accepted` into an older install is out of scope. Add `accepted` to any schema or validation list the import checks, so a v2 archive with it round-trips.

## Tests
- `status ... accepted` writes the event and the status. An offer email afterwards leaves it `accepted`.
- The decoder skips a new posting at a company and role the user holds (dedupe), the same as for `offer`.
- Hand-off: with one accepted and one interviewing application, "Jobs I hold" lists the first, "in progress" lists only the second, and an accepted application with a future interview date appears under "Coming up" with the probation note.
- Tracker row for `accepted` = Offer/Offer with the "Accepted" note. Today API: accepted roles are absent from follow-ups.
- Export then import round-trips an `accepted` application unchanged.

## Done when
`npm test` passes on Linux and Windows; README status list and the Russian install guide mention the new status; ROADMAP marks it done. PR description lists what was built, what was not, and open questions.
