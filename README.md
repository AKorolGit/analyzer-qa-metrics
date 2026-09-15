# qa-metrics-analyzer

Collects quality metrics from a tracker (**Azure DevOps** or **Jira**) and git,
assesses whether the data can be trusted, computes the metric base, and produces
a **diagnostic report built on combinations of metrics** rather than on isolated
numbers.

The tool is built for the assumption "I do not know this project": it first
measures whether the data can support any conclusion, and only then computes
metrics. The ones it cannot compute appear as **explicit blind spots** rather
than silent omissions.

---

## 1. Inputs

| Source | What it sets | Required |
|---|---|---|
| `config/profile.json` | Project profile (D7): tracker, repository, period, window W, **the version of every formula**, `Env` / `Imp` / resolution rules, mandatory field list, thresholds, releases, sprints | yes |
| `.env` | Credentials: `ADO_PAT`, or `JIRA_EMAIL` + `JIRA_API_TOKEN` + `JIRA_FIELD_MAP`, and `GITHUB_TOKEN` / `REPO_PATH` | yes (except `fixture`) |
| CLI flags | `--profile <path>`, `--run <runId>`, `--out <dir>`, `--offline` | no |
| `config/risk-register.json` | Risk register (likelihood × impact) and requirement list → Q4, Q5, G1, G2 | no |
| `config/gate-decision.json` | Release decision and signed residual risks → Q8, G9, G10 | no |
| `config/cost-model.json` | PAF cost model → Q17 | no |
| `qa-runs/*.json` | Run summaries from the Playwright / Cypress reporters → Q16 | no |

### Key profile fields

```jsonc
"versions": {
  "tDet": "v2",          // v1 earliest linked observation | v2 created date
  "env":  "v2",          // v1 environment field | v2 tag or title prefix | v3 reporter | v4 keywords
  "imp":  "v1",          // v1 Severity (default) | v2 Priority at triage | v3 Priority now | v4 Severity if touched, else Priority
  "module": "v2",        // v1 file path map | v2 component, then area path | v3 owning team
  "cohort": "v3",        // M1: v1 version/sprint detected | v2 dates only | v3 version corrected
  "completeness": "v1"   // D4.1: v1 changed from default | v2 differs from default | v3 simply non-empty
}
```

A version is not a convenience setting. It records **how weak your data is**, and
it is printed in every report. `env.closedWorld: true` ("no signal means not
production") is flagged separately as the most dangerous assumption in the whole
pipeline.

### How the Azure DevOps URL is built

Every ADO call has the shape `{collection}/{project}/_apis/...`. What differs is
where the collection ends:

| Environment | collection |
|---|---|
| cloud | `https://dev.azure.com/{organization}` — organization is a path segment |
| legacy | `https://{organization}.visualstudio.com` — organization is the subdomain |
| on-prem | `https://tfs.company.local/tfs/{collection}` — no separate organization |

So `baseUrl` is the single source of truth and `organization` is optional: it is
appended only when it is not already present, either as the last path segment or
as the hostname's first label. All of these produce the same endpoint, and
pasting a full organization URL no longer yields `/org/org/`:

```jsonc
{ "baseUrl": "https://dev.azure.com",          "organization": "org_name" }
{ "baseUrl": "https://dev.azure.com/org_name", "organization": "org_name" }
{ "baseUrl": "https://dev.azure.com/org_name" }
{ "baseUrl": "https://org_name.visualstudio.com" }                 // legacy domain
{ "organization": "https://dev.azure.com/org_name" }               // org as a full URL
{ "baseUrl": "https://tfs.company.local/tfs/DefaultCollection" }   // on-prem
```

The project name goes through `encodeURIComponent` — spaces in project names are
more common than anyone expects. The resolved endpoint is printed in the
collection notes (`Project endpoint: ...`).

**The response body is included in the exception text**, not just the status.
ADO answers 4xx with a JSON `message` naming the real cause: wrong project name,
a PAT missing a scope, a WIQL query over the 20 000-item cap. A bare
`404 Not Found` sends you debugging the wrong thing. The same applies to Jira
(exception) and to GitHub and Azure Pipelines (a note in the report, since those
degrade rather than fail).

Note that ADO answers **401, not 404**, for a collection that does not exist —
which reads exactly like a rejected token. `npm run check` states both causes.

### Switching tracker

```jsonc
"tracker": { "kind": "azure-devops", "baseUrl": "https://org.visualstudio.com", "project": "Proj" }
"tracker": { "kind": "jira", "baseUrl": "https://x.atlassian.net", "project": "PROJ" }
"tracker": { "kind": "fixture" }   // synthetic data, runs without credentials
```

Custom field reference names differ per instance. Discover them rather than
guess — `npm run fields` lists what this project actually has, with fill rates:

```jsonc
"fieldOverrides": {
  "severity": "Microsoft.VSTS.Common.Severity",
  "rootCause": "Custom.RootCause2",
  "versionDetected": "Microsoft.VSTS.Build.FoundIn",
  "versionCorrected": "Custom.Version"
}
```

An override naming a field this instance does not define is reported as a
`CONFIG ERROR`, not silently resolved to null — "the field does not exist" and
"nobody fills it in" need completely different fixes.

### Code source: local clone or GitHub API

```jsonc
"vcs": { "kind": "local-git", "path": "/path/to/clone", "branch": "main" }  // recommended
"vcs": { "kind": "github", "owner": "org", "repo": "repo", "branch": "main" }
"vcs": { "kind": "none" }
```

A local clone beats the API for three reasons: one `git log` process instead of
one HTTP request per commit (the GitHub adapter caps history at 800 commits and
says so in the notes), no rate limit, and the code never leaves your machine. It
is also the **only** source that can support SZZ later — `git blame` over history
is impossible through an API.

The path need not live in the profile: `REPO_PATH` in `.env` overrides
`vcs.path`, keeping the profile portable between machines.

What the adapter handles, and why none of it is cosmetic:

| Case | Handling | What would happen otherwise |
|---|---|---|
| Rename (`src/{billing => payments}/pay.ts`) | destination path is kept | the rename would register as a phantom hotspot |
| Merge commits | excluded (`--no-merges`) | branch lines counted twice, churn inflated |
| Binary files | 0 lines, count reported in notes | `NaN` in churn |
| Shallow clone | warning in the report notes | truncated history silently understates density |
| Branch does not exist | falls back to all refs, lists available branches | `ambiguous argument` with no explanation |
| `Merged PR 1234:` and `(#77)` | both formats | defect↔PR linkage (Q3) would collapse on ADO repositories |

### Switching CI source

```jsonc
"ci": { "kind": "azure-pipelines", "runSummaryDir": "qa-runs" }  // deployments from ADO, runs from the reporters
"ci": { "kind": "json-file", "runSummaryDir": "qa-runs" }        // runs only
"ci": { "kind": "none" }
```

Jira instances use different custom field ids, so the map lives in `.env`:

```
JIRA_FIELD_MAP={"severity":"customfield_10030","rootCause":"customfield_10041","environment":"customfield_10052","sprint":"customfield_10020"}
```

### Analysis scope

When several products share one tracker project, filter at analysis time:

```jsonc
"scope": { "iterationPathPattern": "\\\\Iteration \\d+" }
```

The filter runs **after** collection, never during it, so the snapshot stays a
complete record and the scope can be re-tuned without another API round trip.
`npm run scope` tests each rule independently against real values — a pattern
that matches nothing produces an empty report, not an error.

---

## 2. Outputs

| Artefact | Path | Overwrite rule |
|---|---|---|
| Raw snapshot | `data/raw/<runId>/snapshot.json` | **immutable**, a repeat write is refused |
| Human report | `data/reports/<runId>/report-<ISO-timestamp>.md` | **a new file every time** |
| Machine report | `data/reports/<runId>/report-<ISO-timestamp>.json` | **a new file every time** |
| Run ledger | `data/runs.jsonl` | append only |

`runId` = `YYYYMMDDHHMMSS-<profile>-<hash>`. Regenerating a report from the same
snapshot creates a new file and leaves the old one, which gives before/after
comparison without an external versioning system.

### Report structure (R5)

1. Scope and derivation — what was analysed and where each derived value came from
2. Purpose of this slice
3. What the data supports — indicators with a precision statement
4. **What cannot be said yet, and why** — blind spots with reasons
5. Diagnosis — combination rules that fired, with confidence
6. Release gate G1–G10
7. Signal versus noise — XmR under Wheeler's rules
8. At most **three** proposals
9. Date of the next slice

Then the appendices: metric register, data fitness table (ISO/IEC 25012),
per-metric breakdowns, collection notes.

---

## 3. Running it

```bash
npm install
npm run demo                      # synthetic data with deliberately planted problems

cp .env.example .env              # real project
cp config/profile.example.json config/profile.json
```

| Command | What it does | Touches the API |
|---|---|---|
| `npm run check` | Validates the profile, then confirms the collection and project exist | one cheap call (`--offline` skips it) |
| `npm run fields` | Lists the fields this tracker project actually has, with fill rates | yes |
| `npm run collect` | Pulls defects, commits and deployments into a new immutable snapshot | **yes, this is the slow one** |
| `npm run scope` | Shows what the scope filter matches, rule by rule, against real values | no |
| `npm run doctor` | Diagnoses the snapshot: which derivations resolved and which fell back | no |
| `npm run releases` | Proposes a releases list from git tags and versions seen on defects | no |
| `npm run report` | Renders a new report from the stored snapshot | no |
| `npm run analyze` | Summary to stdout, writes nothing | no |
| `npm run runs` | History of generated reports | no |
| `npm run ui` | Local web UI: configuration, run/reports, and guide pages | no |
| `npm run full` | check + collect + report | yes |
| `npm run typecheck` | `tsc --noEmit` | no |

Splitting `collect` from `report` is deliberate: collection costs API quota and
time, rendering costs nothing. Change thresholds, scope or a formula version and
re-render against the same snapshot as often as you like.

The UI (`npm run ui`, then `http://localhost:4321/`) does not reimplement
anything — every button shells out to the command above it, so it cannot drift
from what you get in the terminal. The same cadence and gap information from
sections 4 and 6 below is available at `/guide`.

---

## 4. Measurement cadence

Metrics have different half-lives. Reading a quarterly metric monthly invites
reacting to noise; reading a monthly one quarterly means finding out too late.

### Every release

| Action | Why |
|---|---|
| Add a row to `releases` in the profile | The release date is only accurate on the day. Three months later you will be reconstructing it, and DDP@W depends on it being right |
| Update `config/gate-decision.json` | Q8, G9, G10. Shipping with an accepted risk is legitimate; without the record there is no way to prove which happened |
| Refresh `config/risk-register.json` outcomes | Q4, Q5, G1, G2 |

### Every sprint

| Action | Why |
|---|---|
| Check Q7 open critical defects | Gate input, and the cheapest early warning there is |
| Check the flaky rate from the latest runs | While nobody reads red, no other CI signal works — this is first in the action order |

### Monthly — the main measurement cycle

```bash
npm run collect
npm run doctor
npm run report
```

Covers Q9 DDP, Q10 field defects, Q13 reopen rate, Q16 regression capability,
M4.3 change failure rate, M4.4 fix response, M4.6 backlog index, M4.9 planning lag.

`doctor` between collect and report is not optional. It shows where each derived
value came from, and a shift there (say, cohorts falling back to dates instead of
versions) changes what the numbers mean without changing how they look.

### Quarterly

```bash
npm run fields        # have custom fields changed? new ones appeared?
npm run report
```

Covers Q1–Q3 data trust, Q14 clusters, Q15 insertion activity, Q17 cost of
quality. These move slowly; monthly readings would be noise.

Also quarterly: review the XmR limits. Wheeler's limits are computed from the
data, so after a real process change they need re-baselining — otherwise the new
normal keeps signalling.

### One-off, at setup or after a tracker change

```bash
npm run check
npm run fields
npm run scope
```

### Never on a schedule

The practices behind document 05 — mutation testing, environment parity checks,
code review analytics — run **under a hypothesis** produced by a metric, not on a
calendar. Each costs days of work and is worth it only when something specific
points at it.

---

## 5. How it works

```
tracker/vcs/ci  →  Snapshot  →  Scope  →  Fitness (D4)  →  Normalize (M1, M2, Imp)
                                              ↓                    ↓
                                            Gate  ───────→  Metrics registry
                                                                   ↓
                                          Indicators → Combination rules → Findings
                                                                   ↓
                                                             XmR signals
                                                                   ↓
                                                                Report
```

Ports and adapters: `src/core` knows nothing about ADO or Jira. Adding a tracker
is one file in `src/adapters/tracker` that returns `RawDefect`.

**The fitness gate** is the central idea. Every metric declares which fields and
sources it depends on. If a field is unfit — completeness below 50%, a dominant
value above 85%, or fill rate that depends on team or priority (MAR/MNAR, after
Rubin) — the metric is marked `NOT COMPUTABLE` with a reason. Computing something
on 41% fill and showing it to management is worse than computing nothing.

**Combination rules** are the tables from the method (Q1 × volume, DDP × field
defects, flaky × DDP, reopen × fix time, clusters × CFR, traceability). The tables
are binary while an indicator is three-state: a mid-range value is coerced to the
nearer side, but the finding is then downgraded from `confirmed` to `hypothesis`.
A combination is a hypothesis with a first action, never a verdict.

**XmR** separates signal from noise under Wheeler's three rules. Reacting to
every fluctuation is tampering, and it makes the process worse.

---

## 6. What each metric still needs

Nothing here is hidden. Every row also appears in section 4 of the report as an
accepted blind spot — absent, not green.

| Metric | State | What is missing | How to supply it |
|---|---|---|---|
| Q4 risk coverage | implemented, needs input | `config/risk-register.json` | A risk workshop or FMEA produces the first one in an afternoon. Score likelihood × impact 1–5 and link tests |
| Q5 requirement coverage | implemented, needs input | Requirement list in the same file | Cheapest durable version: tag the automation code (`@req:US-481`) and export the tags alongside the run — then this becomes collectable instead of manual |
| Q8 residual risk | implemented, needs input | `config/gate-decision.json` | A decision record, not a measurement. Write it at the gate, one file per release |
| Q17 cost of quality | implemented, needs input | `config/cost-model.json` | Hours × rate per PAF category. An estimate is fine if labelled one — it still produces the business case |
| Q16 regression capability | implemented, needs input | `qa-runs/*.json` from the reporters | Register `reporters/playwright-qa-reporter.ts` in the runner and publish `qa-runs/` as a pipeline artefact. No CI API can substitute — see section 8 |
| Q6 test execution status | not implemented | Per-test-case results tied to a release | Needs a TMS or per-case results in the run summary. Pipeline aggregates cannot answer it |
| Q11 reliability, MTTR, MTBF | not implemented | Monitoring or incident source | M4.3 already approximates the worst part from unplanned patches and rollbacks |
| Q12 performance and security | not implemented | Load test results, SAST/DAST output | Cheap once those run in the pipeline — they already emit machine-readable reports |
| A1–A14 code archaeology, SZZ | not implemented | Defect↔PR linkage ≥ 25% without skew | The tool checks this precondition (Q3) and blocks the conclusions until it holds. Make the defect↔PR link mandatory in the pipeline first |
| K1 reconciliation | not implemented | Reconciliation points | Only applies when the product moves money or financial data between systems |
| K6 RBT effectiveness | not implemented | Q4 plus the six questions of CTAL-TM 1.3.6 | Partly derivable once the risk register exists |

Two failure modes the tool cannot fix for you, and reports instead:

**Env resting on the closed-world assumption.** If most defects carry no
production marker, DDP is an upper bound rather than a measurement. The report
prints the marker agreement table so the gap is visible: two independent markers
that disagree often mean the convention is not being followed, and the true
production count is at least the marked one and possibly higher.

**A field filled by the tracker rather than by a person.** Severity at 100%
completeness with one dominant value carries no information. Completeness v1 and
the dominance check exist to catch exactly this, but the fix is a process one.

---

## 7. What the tool deliberately does not do

| Thing | Reason |
|---|---|
| Real-time dashboard | The method names this as a trap: presenting a dashboard instead of decisions. A report that changes no decision has not worked |
| Automatic M3 double sampling | Requires manual labelling of a sample. Only the arithmetic can be automated — Wilson intervals are already there — not the labelling |
| LLM classification of root cause | Data policy: internal project data does not go to external APIs. Developers already fill root cause for high-priority defects |
| Metrics about people | Author data stays inside module-level aggregates. Code and process, not individuals |

---

## 8. Failure classification: SUT / TAS / inconclusive

`Q16` rests on a distinction **no CI API provides**: the ADO Test API and GitHub
Actions report "failed" and nothing more. Only the runner knows the difference.

`reporters/` contains:

| File | What it does |
|---|---|
| `failure-class.ts` | TAS patterns (network, browser crash, hook, container) and the inconclusive rule |
| `playwright-qa-reporter.ts` | Counts `expect` steps: a green test with no assertion is recorded as **inconclusive**, not passed |
| `cypress-qa-plugin.ts` | The same through `command:end` + `after:run`; on Cypress the inconclusive count is a lower bound |

Wiring Playwright:

```ts
// playwright.config.ts
reporters: [['./reporters/playwright-qa-reporter.ts', { outputDir: 'qa-runs' }]]
```

The TAS patterns are a starting point. The syllabus requires the definitions to
be **explicit and consistent**, not clever, which is why the list is version
controlled and calibrated against your own failures.

---

## 9. Sources

ISTQB CTAL-TM v3.0, CTEL-ITP v1.0, CTAL-TAE v2.0, CTAuT, CT-FT ·
ISO/IEC 25012, ISO/IEC/IEEE 15939, IEEE 1044 ·
Kan, *Metrics and Models in Software Quality Engineering* ·
Wheeler, *Understanding Variation* · DORA ·
Luo et al. (2014) flaky tests · Rubin (1976) missing data · Tenenbein (1970)
double sampling.
# analyzer-qa-metrics
