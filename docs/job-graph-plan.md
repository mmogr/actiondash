# Job graphs: implementation plan

**Goal.** Draw each run as a graph of its jobs, the way GitHub's run page does. Show the jobs that don't exist yet. Use them to say when the whole run finishes and when its later macOS jobs will queue again. Keep the dashboard's existing promises: one origin, a fixed request budget, and no time shown that it can't back up.

Status: plan only. Nothing here is built yet.

## What the research established

The research ran in November 2026, against 30 repositories: 8 of mine and 22 busy public ones, several of them macOS-heavy.

- **The graph only exists in the workflow file.** No REST or GraphQL endpoint returns `needs:`, whatever the permission. Check runs carry no dependency data, and fine-grained tokens can't be given the Checks permission anyway. github.com's own graph view uses a cookie session and is blocked by our CSP. The workflow YAML, read through the contents API, is the only source.
- **A waiting job isn't listed until it exists.** GitHub's jobs listing has no entry for a job whose `needs:` haven't finished.
- **Matching works.** Across 91 runs, the listings held 486 jobs:
  - 477 matched a declared job.
  - 8 belonged to two interchangeable jobs, drawn as one node.
  - 1 was a check run created by a step, which is not a job.
  - None were left unmatched.
- **The timing is exact.** All 196 dependent jobs that ran were created within 2 seconds of their last declared dependency finishing. This makes a cheap check that a graph is right.
- **Fetching is free in the steady state.** The contents ETag is the file's blob SHA. Sending it to a later commit where the file is unchanged returns 304, which doesn't count against the rate limit (confirmed). So a new run costs nothing unless its workflow file changed.
- **Parser.** `js-yaml` (15 KB gzipped, no `eval`) parsed all 420 workflow files. The `yaml` package, and GitHub's `@actions/workflow-parser` built on it (72 KB gzipped), rejected one that GitHub runs.
- **Hard cases resolved:**
  - matrices computed at run time (rust-lang)
  - reusable workflows nested three deep, 13 files in one run (electron)
  - jobs named only from matrix values (Alamofire)
  - skipped jobs listed under their raw `${{ }}` name
  - fork PRs
- **No permission covers only workflow files.** Reading them needs Contents: read, which is repository-wide. Public repositories should need nothing extra, according to GitHub's docs, but that is untested with a fine-grained token (step 0).

There is a clickable mockup replaying 9 real ggchat and gglib runs. It is private to its owner, who can share it from its Share menu: https://claude.ai/artifact/CNmmnGQRuDfiF9MY8CnDWj

## Decisions taken in this plan

These are open to change before any code is written.

1. **Layout.** The Now screen becomes pool gauges and timelines on top, then **one list of runs** below. Today each pool section has its own run list, so a run that uses macOS, Linux and Windows appears up to three times, and a graph belongs to the whole run.
   - The alternative was to draw the graph once, under the run's most pressured pool, and reduce its other appearances to a pointer. That keeps today's layout but splits a run across sections. The mockup used one list, and it reads better.
   - The text-only gains (phase 4) ship before this restructure and don't depend on it.
2. **Forecast.** Replace the per-pool `forecastBucket` internals with **one simulation across the account**. A macOS job that appears when a Linux job finishes depends on another pool, so per-pool forecasting can't place it. The simulation still produces today's `BucketForecast` and `RunForecast` shapes, so `QueueTimeline`, `SummaryTiles`, `YourRuns` and `InsightCard` keep their inputs.
3. **Fetching.** Add a sibling of `apiFetch` in `client.ts` for raw files, with an explicit `If-None-Match`. Keep a graph cache keyed by repository and path, separate from the URL-keyed ETag cache.
4. **Opt-in per repository.** The graph is off until chosen for a repository. A repository without it keeps today's job list.

## Step 0: check the one untested assumption

Do this before any code:

1. Create a fine-grained token with one repository selected and Actions: read only.
2. Request `GET /repos/{owner}/{repo}/contents/.github/workflows/<file>` with `Accept: application/vnd.github.raw+json` for a public repository that is *not* selected.

- **200:** public repositories need no opt-in.
- **Anything else:** every repository needs opt-in, and Contents: read on the token.

Record the result in this file.

## Phases

Each phase is one pull request and ends with `npm run verify` passing.

### Phase 1: the workflow model (pure, no network)

New `src/model/workflow.ts`:

- **`extractWorkflow(text)`**
  - Parses with `js-yaml`.
  - Keeps only `jobs.*` and, within each job, `name`, `needs`, `if`, `uses`, `strategy.matrix`, and the steps' `name`, `uses` and `run`.
  - A parse error returns `null`, never throws.
- **`expandGraph(workflow, resolveCalled)`** turns the jobs into nodes with ids and edges:
  - Reusable workflows expand recursively, named `caller / callee`, or `caller (…) / callee` when the caller has a matrix. Their root jobs inherit the caller's `needs:`. A `needs:` that names a caller means every job inside it. A skipped caller matches its own bare name.
  - A called workflow that can't be read becomes one opaque group, `caller / …`, carrying the caller's `needs:`.
  - Fixed matrices expand under GitHub's `include` and `exclude` rules. A name made only of `${{ matrix.x }}` is evaluated exactly.
  - A matrix computed at run time stays one node with a wildcard name and an unknown count.
- **`matchJobs(graph, listing)`** tries these rules in order:
  1. The raw template name (skipped matrix jobs are listed under it).
  2. The bare caller name.
  3. An exact or fixed-matrix name.
  4. A name pattern, optionally followed by ` (…)`.
  5. Step names, which exist only once a job has started.
  6. Structural merge: jobs with the same name template, `needs:` and dependents become one node.
- **`validate(graph, listing)`** returns ok or a reason:
  - Check runs are filtered out first: empty `labels`, `runner_name: null`, and an `html_url` without `/job/`.
  - The structural merge is applied next.
  - Every listed job must match.
  - Every dependent job that ran (not skipped or cancelled) must have been created within 2 s of its declared dependencies' last end.
- **`graphState(graph, listing)`** gives each node one of: passed, failed, skipped, cancelled, running, waiting, or not created yet. It also gives matrix counts.

Tests in `tests/workflow.test.ts`, with fixtures taken from real runs found by the probe. Store them as files, not live calls:

| Case | Source | Expect |
| --- | --- | --- |
| Matrix computed at run time | rust-lang/rust `ci.yml` | 1 node, 11 instances, all edges explained |
| Nested reusable workflows | electron `build.yml`, 13 files | 49 of 49 matched, the skipped caller by its bare name |
| `include`-only matrix | Alamofire `ci.yml` | 56 of 56 by exact name |
| Two interchangeable jobs | home-assistant `ci.yaml` | `pytest-mariadb \| pytest-postgres` merged |
| Skipped job with its raw `${{ }}` name | grafana, realm | matched by raw name |
| Check run in the listing | next.js `pull_request_auto_label.yml` | filtered out, not a job |
| File GitHub accepts, `yaml` rejects | WordPress-iOS `validate-issues.yml` | parses |
| Cancelled run | actiondash `deploy.yml` | validation passes (cancelled dependents excluded) |
| Bad YAML, missing file, required workflow, `dynamic/` workflow | constructed | no graph, reason given |
| Timestamps skewed | gglib runs of 1 Nov | validation passes: the skew moves a job and its dependencies together |

**Done when:** these pass; `js-yaml` is in the bundle and `check:csp` still passes; the model has no network access, which `check:fetch` confirms.

### Phase 2: fetching and caching the file

**`src/github/client.ts`:**

- Add `apiFetchRaw(path, { etag })`.
  - It sends `Accept: application/vnd.github.raw+json` and an explicit `If-None-Match` when an ETag is given.
  - It returns `{ status, text, etag }`.
  - It goes through the same origin guard, rate-limit capture and `retry-after` handling as `apiFetch`.
- The URL-keyed cache is left alone.

**New `src/state/graphs.ts`:**

- A cache keyed by `owner/repo::path`, holding `{ etag, workflow, fetchedAt }`.
- Bounded like `MAX_KEYS`.
- Kept in local storage under its own key.
- Cleared by `forgetEverything()`.
- Called workflows are cached by `owner/repo::path@sha`, since `referenced_workflows` pins them exactly.

**`src/github/poller.ts`** gains `loadGraphs()`, run after the jobs poll:

- **Which runs.** Only runs that are active, in an opted-in repository, and have no graph yet.
- **Which version of the file.**
  1. Fetch the file at the run's full `head_sha`, sending the last ETag held for that path.
  2. Validate it against the listing.
  3. If validation fails, try the default branch's version once.
  4. If that fails too, record "graph unavailable" for that run and never ask again.
  - So each run costs at most two attempts, ever.
- **Called workflows.** Use the SHAs from the run's `referenced_workflows`. Fall back to the `uses:` `@ref` only when an entry is missing.
- **Budget.** Same gate as `learnFinishedRuns`: nothing below `LEARNING_MIN_REMAINING` (200 left), and the same concurrency limit. A 304 is free; a 200 is billed and the pacer already counts it.
- **No waiting.** The run card never waits on this. It shows today's job list until the graph arrives.
- **Store.** A new `graphs` signal in `store.ts`, keyed by run id, holding the validated graph or the reason it's unavailable.
- **When re-validation happens.** On each poll where the run's jobs changed. A graph that later stops fitting is dropped to "unavailable", not redrawn wrongly.

Tests:

- `tests/client.test.ts`: raw fetch, explicit ETag, a 304 counted as free.
- `tests/poller.test.ts`: the fetch order, one attempt per version, the 200-remaining gate, and that nothing is fetched for a repository that hasn't opted in.

**Done when:** a run in an opted-in repository gets a validated graph in the store within one poll of appearing. A second run of the same workflow costs a 304, which is free.

### Phase 3: opt-in, token check and the security wording

- **`Settings`** gains `graphRepos: string[]`, a list of repository keys. Repositories in it read their workflow files.
- **Settings and setup** offer the opt-in per repository, with one sentence saying exactly what it grants:

  > Reading the workflow file needs Contents: read on this repository. That permission can read all of its code. The dashboard uses it only for `.github/workflows/`.

- **`probeRepos`** also probes Contents for opted-in repositories, with the same short-circuit on 401 and rate limit. It names any repository it can't read, the way it does for Actions today.
- **README:**
  - Token setup: Contents: read is optional, and needed only for graphs on private repositories.
  - Security model: "do not grant Contents" and "never reads your code" become an exact statement of what is read and when.
  - Storage: "job names and seconds, nothing else" adds the cached workflow structure.
  - Request budget: add the cost, one request per edit of a workflow file and nothing otherwise.
- **`check:guards` and `e2e/guards.ts`:** the token may now appear only in the `Authorization` header of contents requests too. No new origin is allowed.

**Done when:** setup, recovery and settings handle opted-in and not-opted-in repositories, and a token missing Contents is named as such. The README matches the code.

### Phase 4: account-wide forecast and text-only gains

New `src/model/simulate.ts`: one event simulation for every pool.

- **The model.** FIFO by `created` within each pool's cap. A job is created once all its `needs:` have ended. Linux and Windows are uncapped where the plan says so.
- **Basis.** Each time keeps its `Basis`:
  - A job that doesn't exist yet takes the worst basis in its chain.
  - A matrix computed at run time is "at least one job, guessed".
  - A floor is kept as a floor ("or later").
- **Kept from today's forecast:**
  - `MIN_REMAINING_MS`
  - the overdue rules
  - the `exclude` set that `insightFor` uses for "cancel this stale run first"
- **What it produces.** The existing `BucketForecast` and `RunForecast` shapes, so every current user of the forecast is unchanged. The `forecasts` computed value in `store.ts` switches to it.
- **Existing tests.** Every existing case in `tests/forecast.test.ts` must pass unchanged when a run has no graph. New cases cover:
  - a later stage queuing again behind jobs that arrived in the meantime
  - a macOS job waiting on Linux jobs
  - a matrix computed at run time
  - a failed dependency skipping its dependents

Visible changes in this phase, all text:

- `RunForecast.allDone` covers the whole run, so YourRuns and the tab title say "done ~14:52" for a run with a graph. Runs without one keep "current jobs done".
- The insight card and summary tiles count jobs that don't exist yet but will need a slot: "app #412 will start 4 more macOS jobs in ~3m."

**Done when:** a run with a graph shows a whole-run end time, and a run without one reads exactly as today.

### Phase 5: the graph card and the new Now layout

**Layout (decision 1).** The pool sections keep their gauge, sentence and `QueueTimeline`, but lose their run lists. One run list follows. It shows the reader's runs first, then the others by the pressure on the pools they use, oldest first within that. Filter chips, bulk cancel and the stale-run note keep working on this list.

**`RunGroup.tsx`** draws the graph when the run has one, and today's job list when it doesn't:

- **Layout.** Columns by depth; nodes laid out as HTML over an SVG layer for the edges. Edges into jobs that don't exist yet are dashed. Those nodes are dashed boxes on a solid background, so edges never show through them.
- **Folding.** Leading stages where everything passed fold into one "N jobs done" node. A stage containing a failure is never folded.
- **No `needs:` at all** (all of ggchat, and the most common shape): draw a wrapped grid, busiest first, not a single tall column.
- **Matrices.** One node with "×N" and a count by state. A matrix computed at run time says its count is unknown until it starts.
- **Each node shows** its state, the `MAC` pool tag while it still needs a slot, and one line of detail:
  - "12m · usually 14m"
  - "3rd in line · ~09:40"
  - "not created yet · ~10:34"
  - "passed · 9m"
- **Collapsed cards** show a one-line row of stages (one square per job), the run's summary and "done ~". The reader's watched run is open by default. Tapping a card opens or closes it.

Decisions the mockup surfaced. Each needs settling with screenshots in this phase:

- **Deep chains overflow.** gglib's 6-level Release needs horizontal scrolling even at 1280px with 196px nodes. The options are narrower nodes, folding more than the passed prefix, or a vertical layout below some width.
- **Short tails all say the same time.** When later stages take seconds, every node there says "~10:34". When neighbouring times are within a minute, show order ("then") instead of repeating the time.
- **Long job names truncate** ("Build Swift framew…"). Keep the full name in the tooltip and the sheet. Consider two lines on wide screens.
- **Phone.** The mockup was never checked at phone width. This phase needs its own pass at 390px.

**Done when:** screenshots at 390px and 1280px, in dark and light, for these cases:

- a run with no `needs:`
- a deep chain
- a matrix computed at run time
- a run whose graph is unavailable
- the reader's own run waiting behind another repository

Plus every existing e2e test, updated for the new layout.

### Phase 6: "why is this waiting?"

Tapping a waiting or not-yet-created job opens a sheet. It is a side panel on desktop and a bottom sheet on a phone; Escape closes it and focus returns to the node. It shows:

- **Place in line and expected start**, with what the forecast rests on.
- **The jobs ahead**, grouped by run with counts. Those runs' collapsed cards get an "N ahead" badge, and the jobs ahead are outlined where visible.
- **Which running job frees the next slot, and when.**
- **A strip of the pool's slots** from now until the job runs, with that job outlined.
- **For a job that doesn't exist yet:** which jobs it waits on, and that it then joins the line.

Running and finished nodes open the same sheet, with elapsed time against the usual time, or how the job ended and a link to its log.

**Done when:** keyboard and screen reader can open, read and close it (`check:focus` passes); there is an e2e test per sheet kind.

### Phase 7: end-to-end tests and the probe

- **`e2e/github.ts`.** `BrowserGitHub` gains a contents route serving raw YAML with ETags and 304s. Add scenarios: graph on, graph off, validation failing and falling back, Contents refused on an opted-in repository, a 304 on the second run of a workflow.
- **`scripts/probe.mjs`** gains a section that re-checks what this design assumes about GitHub:
  - a dependent's `created_at` matches its last dependency's end
  - a cross-commit 304 on the contents API
  - skipped jobs listed under raw template names
  - check runs appearing in job listings
  - `created_at` never later than the response's `Date` header (see the follow-ups)

## Out of scope, as follow-ups

- **Runs held by `concurrency:`.** A modelpipe-ffi run waited 71 minutes with no jobs. The dashboard asks only for `queued` and `in_progress`. Adding `pending`, `waiting` and `requested` to `RUN_STATUSES` would show these. With a graph, they could be drawn whole. The status value GitHub uses for a concurrency hold is unverified.
- **Runs waiting for approval.** 19 sampled runs ended `action_required` with no jobs: fork PRs waiting for a maintainer.
- **GitHub's clock can be wrong.** On 1 November at 09:14 UTC, by GitHub's own `Date` header (and a rate-limit reset that agrees with it):
  - gglib runs reported `created_at` 09:19 and 09:43, both in the future.
  - Some jobs reported `completed_at` before `started_at`.
  - The graph is unaffected: those runs still passed validation, because the skew moved each job and its dependencies together.
  - Every time measured against the browser clock is wrong during a skew: "11m running", "waiting 4m", and forecasts anchored to now. Measuring against the response's `Date` header instead would fix all of them.
- **Arrows between repositories.** The mockup shows the jobs ahead with outlines and the sheet rather than edges between cards. Edges across cards were rejected as unreadable. Revisit only with a reason.
