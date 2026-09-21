# actiondash

A cross-repository dashboard for GitHub Actions queues.

GitHub caps concurrent jobs per account, not per repository. On Free, Pro and
Team that is **5 concurrent macOS jobs**, shared across every repository you
own. The GitHub web interface shows none of this: it will not tell you how much
of the pool is in use, where a queued job sits in line, or that a run still
holding a slot was superseded three commits ago.

actiondash shows those three things in one page, across every repository you
choose, and lets you cancel the runs that are wasting slots.

```
macOS                          5/5 in use    7 queued    ~14m wait

  RUNNING
  run   app       #412   build-arm    feat/parser   a1b2c3d   11m   cancel
  run   site      #88    test         main          9f8e7d1    3m   cancel

  QUEUED - waiting for a slot
   1    app       #414   build-arm    feat/parser   d4e5f6a  STALE   9m   cancel
   2    app       #415   build-arm    feat/parser   77aa119          2m   cancel
```

## Security model

The dashboard is a static page with no backend. Your token is held in your own
browser and is sent to GitHub and nowhere else. Three independent controls
enforce that:

1. **Content Security Policy.** The page ships a strict policy in a
   `<meta http-equiv>` tag, since GitHub Pages cannot set headers. It is
   `default-src 'none'` with `connect-src https://api.github.com` and nothing
   else, so the browser refuses any network connection to another host. There
   is no `'unsafe-inline'` and no `'unsafe-eval'`, so injected markup cannot
   execute. Every asset is same-origin; no CDN, no web fonts, no avatars.
2. **Origin guard.** `src/github/client.ts` is the only module that touches the
   network. It resolves each URL and throws before issuing the request if the
   origin is not `https://api.github.com`, so the token is never attached to
   anything else even if the CSP were absent.
3. **Build-time checks.** `npm run check:csp` fails the build if the policy is
   missing, weakened, or if an inline script or external asset appears in the
   output. `npm run check:fetch` fails if any module other than the API client
   calls `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`.
   Both run in CI on every pull request and again before every deploy.

The token is never written to the URL, never logged, and never rendered back
into the page. "Forget token" clears it and everything else from local storage.

Two honest limits. A meta-tag CSP cannot express `frame-ancestors`, so
clickjacking protection is not available on GitHub Pages; open the page in a
normal tab. And anyone with access to your browser profile can read local
storage, so use a short token expiry.

## Token setup

Create a **fine-grained** personal access token at
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):

| Setting | Value |
| --- | --- |
| Repository access | Only select repositories, the ones you want to watch |
| Actions | Read and write |
| Metadata | Read (GitHub adds this automatically) |
| Everything else | Leave unset |

`Actions: Read and write` is the whole grant. Read covers listing runs and jobs;
write is needed only to cancel a run. The dashboard never reads your code, so
**do not grant Contents**. Set an expiry of 30 to 90 days.

A classic token also works but is a worse idea: its `repo` scope reaches every
repository you can see. The setup screen warns if you paste one.

## Running locally

```sh
npm install
npm run dev
```

## Verifying

```sh
npm run verify   # tests, typecheck, build, CSP check, network-call check
```

To confirm the policy in a browser, run `npm run preview`, open the page, and
check that the console reports no CSP violations. To confirm it is really
enforcing, run this in the console; it must be blocked:

```js
fetch('https://example.com')
```

## Deploying

Merge to `main`. Every pull request runs `npm run verify` in
`.github/workflows/ci.yml`, and `main` will not accept a merge until it
passes. On `main`, `.github/workflows/deploy.yml` runs the same command again
and publishes to GitHub Pages. Both run on `ubuntu-latest` only, so checking
and deploying the dashboard never compete for the macOS slots it exists to
protect.

Enable Pages once under Settings, Pages, Source: GitHub Actions.

## How it works

Every 15 seconds the browser lists `queued` and `in_progress` runs for each
configured repository, then lists the jobs of runs that have actually moved.

### Staying inside the request budget

This is the part that needed the most care. A personal access token gets
**5,000 REST requests an hour**. The naive cost of a poll is
`2 x repositories + active runs`, which at a 15-second interval overruns that
budget as soon as a dozen runs are genuinely in flight:

| Scenario | Naive cost per poll | Per hour at 15s |
| --- | --- | --- |
| 10 repositories, idle | ~0, all conditional hits | ~0 |
| 10 repositories, 20 runs in flight | ~24 | ~5,760, over budget |

Conditional requests alone do not fix this. They make the dashboard free when
nothing is happening and expensive exactly when you need it, because a running
job's steps advance constantly and its job listing always returns 200. Three
mechanisms bring it back inside:

1. **Conditional requests.** Every call carries an `ETag`, and GitHub
   [does not charge a 304 against the primary rate limit](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
   A repository with no change costs nothing.
2. **Change detection on the run.** A run listing already reports `updated_at`,
   so a run whose timestamp has not moved cannot have new job state, and its
   job listing is skipped entirely rather than merely being cheap. This is the
   difference between paying for every active run every poll and paying only
   for the ones that advanced.
3. **Budget-derived pacing.** The interval is computed from the measured cost
   of the last poll and the allowance left before the window resets, spending
   at most 60 percent of it. Your configured interval is a floor, not a
   promise. When a poll turns out to be expensive the cadence stretches, the
   footer says `paced to 40s`, and the budget holds. `retry-after` and
   `x-poll-interval` are obeyed ahead of any of this.

Because the interval is derived from the remaining allowance rather than
checked against a threshold, overrunning is not something the dashboard can do.
The worst case is that it waits for the window to refill, which it will say it
is doing. The footer always shows the live cost, for example
`13/refresh, ~3,100/hr`, so the number is never a mystery.

Jobs are grouped by the concurrency pool they draw from, read off the runner
labels. Self-hosted is detected first and on purpose, because a self-hosted
macOS runner uses your own capacity rather than the GitHub-hosted allowance.

### The plan setting, and why it is a guess that corrects itself

The occupancy meters need a denominator, which means knowing the account's
concurrency ceiling. The API will not tell you: `GET /user` exposes the plan's
name, never its limits, and a limit raised by GitHub Support would not show
even there. So you pick the plan once at setup.

A wrong pick can sometimes correct itself, because a ceiling leaves evidence: a
count of jobs genuinely running at one instant is a lower bound on the cap,
whatever was selected. The dashboard records the most it has seen and offers
the smallest plan that could produce it. It never suggests a smaller plan,
because a quiet account proves nothing about its ceiling.

The reason that is hedged is that a count is only evidence when it is a
measurement, and four things have to hold before this one is:

- **Deduplicated.** Queued and in-progress runs come from two separate
  requests, so a run that changes status between them can appear in both, and
  one repository watched under two spellings appears twice. Every job is
  counted once, by id. GitHub's documentation says the `status` filter matches
  a run's check runs, which suggests partly started runs come back from both
  listings routinely. A check on 2026-09-21 across five busy public
  repositories (about 378 active runs) found no overlap at all, so the dedupe
  is a safeguard, not the fix for a known miscount.
- **Contemporaneous.** Job data is cached for up to ninety seconds and the
  repositories are swept a few at a time, so a reading can blend moments a
  minute apart. That is fine to look at and useless as proof, so a poll that
  reused anything older than the sampling window does not vote.
- **Corroborated.** A high-water mark never comes back down, so one bad sample
  would be permanent. Three consecutive polls have to support a figure, which a
  real ceiling reaches over and over anyway.
- **From a single owner.** The ceiling belongs to the account that **owns**
  each repository, not to whoever holds the token. Watching several owners
  aggregates pools GitHub meters separately, so the meters are not meaningful
  and no suggestion is made at all. Watch one owner's repositories at a time.

When an observation survives all four and still exceeds every plan below
Enterprise, the honest conclusion is that the count is wrong rather than that
the account is an enterprise: Free, Pro and Team all cap macOS at five, so a
macOS excess on its own cannot tell them apart, and the next rung up is fifty.
The dashboard says so instead of recommending a plan, and offers to recheck.
Stating your plan outright clears the observation too, on the grounds that it
is newer evidence than an old inference.

The refresh interval is deliberately not part of setup. Before the first poll
there is nothing to base it on, so it lives in the footer beside the live cost
readout, where the effect of changing it is visible. It is a floor rather than
a promise, since the budget pacer will stretch it when a poll turns out to be
expensive.

**Queue position is an estimate.** GitHub does not publish a job's place in
line. Jobs are ordered by arrival time, which matches how a pool is dispatched
in practice, but it is a proxy and it will occasionally be wrong.

**Stale detection** compares runs already fetched. A run is superseded when a
newer run exists for the same repository, workflow and branch on a different
commit. This needs no extra token permission. The trade-off is that a branch
whose newest commit did not trigger that particular workflow will not be
flagged, which is the safe direction: a run is never wrongly marked stale.

## Prevention beats cleanup

Most stale runs should never reach the queue. Add this to your own workflows so
a new push cancels the run it replaces:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

actiondash then handles what still slips through, chiefly cross-repository
contention and runs on branches this pattern does not cover.
