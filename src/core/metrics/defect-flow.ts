import { type MetricDefinition, type SeriesPoint, degradedBy, gate, skeleton } from './contract.js';
import type { NormalizedDefect } from '../normalize/index.js';
import type { MetricContext } from './contract.js';
import { median, quantile, wilson } from '../stats/index.js';

const DAY = 86_400_000;

interface CohortView {
  readonly cohort: string;
  readonly releasedAt: number;
  readonly mature: boolean;
  readonly preRelease: readonly NormalizedDefect[];
  readonly field: readonly NormalizedDefect[];
  readonly klocChanged: number | null;
  readonly stories: number | null;
}

/** Groups defects into release cohorts and applies the observation window W. */
export function cohortViews(ctx: MetricContext): readonly CohortView[] {
  const w = ctx.profile.windowDays * DAY;
  const byCohort = new Map<string, { releasedAt: number; kloc: number | null; stories: number | null }>();
  for (const r of ctx.snapshot.releases) {
    const cur = byCohort.get(r.cohort);
    const at = Date.parse(r.releasedAt);
    if (cur === undefined || at < cur.releasedAt) {
      byCohort.set(r.cohort, { releasedAt: at, kloc: r.klocChanged, stories: r.storiesDelivered });
    }
  }
  const views: CohortView[] = [];
  for (const [cohort, meta] of byCohort) {
    const members = ctx.defects.filter((d) => d.cohort === cohort);
    const field = members.filter(
      (d) => d.env === 'prod' && Date.parse(d.tDet) <= meta.releasedAt + w,
    );
    views.push({
      cohort,
      releasedAt: meta.releasedAt,
      mature: ctx.now.getTime() >= meta.releasedAt + w,
      preRelease: members.filter((d) => d.env !== 'prod'),
      field,
      klocChanged: meta.kloc,
      stories: meta.stories,
    });
  }
  return views.sort((a, b) => a.releasedAt - b.releasedAt);
}

const isImportant = (d: NormalizedDefect): boolean => d.imp === 'critical' || d.imp === 'high';

/** Q9 / M4.2. Defect Detection Percentage @W, overall and on important defects. */
export const q9Ddp: MetricDefinition = {
  id: 'Q9',
  name: 'Defect Detection Percentage (DDP) @W',
  block: 'C. Field outcome',
  // Env is resolved by the version chain (M2), so no single field is a hard
  // dependency. Coverage of that resolution is reported as a caveat instead.
  dependsOnFields: [],
  dependsOnSources: ['defects', 'releases'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const views = cohortViews(ctx).filter((v) => v.mature);
    if (views.length === 0) {
      return skeleton(this, {
        status: 'not-computable',
        caveats: [`No cohort has completed the W=${ctx.profile.windowDays}-day observation window.`],
      });
    }
    const minN = ctx.profile.thresholds.minCohortSize;
    const series: SeriesPoint[] = [];
    const breakdown: Record<string, string | number | null>[] = [];
    let preAll = 0;
    let fieldAll = 0;
    let preCrit = 0;
    let fieldCrit = 0;

    for (const v of views) {
      const pre = v.preRelease.length;
      const fd = v.field.length;
      const denom = pre + fd;
      const ddp = denom === 0 ? null : pre / denom;
      const preC = v.preRelease.filter(isImportant).length;
      const fdC = v.field.filter(isImportant).length;
      const denomC = preC + fdC;
      preAll += pre;
      fieldAll += fd;
      preCrit += preC;
      fieldCrit += fdC;
      if (ddp !== null && denom >= minN) {
        series.push({ label: v.cohort, value: ddp, mature: true, n: denom });
      }
      breakdown.push({
        cohort: v.cohort,
        preRelease: pre,
        fieldDefects: fd,
        DDP_all: ddp === null ? null : Number(ddp.toFixed(3)),
        DDP_crit: denomC === 0 ? null : Number((preC / denomC).toFixed(3)),
        n: denom,
        smallSample: denom < minN ? 'yes' : 'no',
      });
    }

    const ddpAll = preAll + fieldAll === 0 ? null : preAll / (preAll + fieldAll);
    const ddpCrit = preCrit + fieldCrit === 0 ? null : preCrit / (preCrit + fieldCrit);
    const ci = wilson(preCrit, preCrit + fieldCrit);
    const target = ctx.profile.thresholds.ddpTarget;

    return skeleton(this, {
      status: degradedBy(this, ctx).length > 0 ? 'degraded' : 'computed',
      formulaVersion: `W=${ctx.profile.windowDays}d, Env ${ctx.profile.versions.env}, Imp ${ctx.profile.versions.imp}`,
      value: ddpCrit,
      unit: 'share',
      series,
      breakdown,
      requirement: {
        text: target === null
          ? 'No deterioration signal on the process behaviour chart for DDP on important defects (target to be set from baseline)'
          : `DDP_crit >= ${(target * 100).toFixed(0)}% and no deterioration signal`,
        outcome: target === null ? 'unknown' : ddpCrit !== null && ddpCrit >= target ? 'met' : 'violated',
      },
      caveats: [
        `DDP_crit is the headline; DDP_all = ${ddpAll === null ? 'n/a' : (ddpAll * 100).toFixed(1) + '%'} can look good on a mass of trivial pre-release finds.`,
        `95% CI for DDP_crit: ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%.`,
        ctx.profile.env.closedWorld
          ? 'Closed-world assumption is ON: "no signal = not prod". Unvalidated, this inflates DDP. Run M3 double sampling.'
          : 'Defects with Env=unknown are excluded from both numerator and denominator.',
        ...degradedBy(this, ctx),
      ],
    });
  },
};

/** Q10 / M4.1. Field defects per release @W, plus normalised rate. */
export const q10FieldDefects: MetricDefinition = {
  id: 'Q10',
  name: 'Post-release (field) defects @W',
  block: 'C. Field outcome',
  dependsOnFields: [],
  dependsOnSources: ['defects', 'releases'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const views = cohortViews(ctx);
    const mature = views.filter((v) => v.mature);
    const series: SeriesPoint[] = mature.map((v) => ({
      label: v.cohort,
      value: v.field.length,
      mature: true,
      n: v.field.length,
    }));
    const criticalUnanalysed = ctx.defects.filter(
      (d) => d.env === 'prod' && d.imp === 'critical' && (d.raw.rootCause === null || d.raw.rootCause.trim() === ''),
    ).length;

    return skeleton(this, {
      status: 'computed',
      formulaVersion: `W=${ctx.profile.windowDays}d`,
      value: mature.length === 0 ? null : mature.reduce((a, v) => a + v.field.length, 0) / mature.length,
      unit: 'count',
      series,
      breakdown: views.map((v) => ({
        cohort: v.cohort,
        mature: v.mature ? 'yes' : 'no (window not elapsed)',
        fieldDefects: v.field.length,
        critical: v.field.filter((d) => d.imp === 'critical').length,
        high: v.field.filter((d) => d.imp === 'high').length,
        klocChanged: v.klocChanged,
        FDR_per_kloc: v.klocChanged === null || v.klocChanged === 0 ? null : Number((v.field.length / v.klocChanged).toFixed(2)),
      })),
      requirement: {
        text: 'Zero highest-severity production defects without causal analysis; no growth signal on FD and PRDR',
        outcome: criticalUnanalysed === 0 ? 'met' : 'violated',
      },
      caveats: [
        criticalUnanalysed > 0
          ? `${criticalUnanalysed} critical production defect(s) carry no root cause: the causal-analysis rule (Q15) is not being followed.`
          : 'All critical production defects carry a root cause.',
        'Immature cohorts are shown but excluded from the trend - their window has not elapsed.',
      ],
    });
  },
};

/** Q7. Open defects by importance and convergence. */
export const q7OpenDefects: MetricDefinition = {
  id: 'Q7',
  name: 'Open defects by importance, arrival rate and convergence',
  block: 'B. Release gate',
  dependsOnFields: ['priority', 'stateCategory'],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const open = ctx.defects.filter((d) => !d.isResolved);
    const levels: readonly string[] = ['critical', 'high', 'medium', 'low', 'unknown'];
    const openCritical = open.filter((d) => d.imp === 'critical').length;
    const ages = open.map((d) => d.ageDays);
    return skeleton(this, {
      status: degradedBy(this, ctx).length > 0 ? 'degraded' : 'computed',
      formulaVersion: `Imp ${ctx.profile.versions.imp}`,
      value: open.length,
      unit: 'count',
      breakdown: levels.map((lvl) => {
        const bucket = open.filter((d) => d.imp === lvl);
        return {
          importance: lvl,
          open: bucket.length,
          medianAgeDays: bucket.length === 0 ? null : Number((median(bucket.map((d) => d.ageDays)) ?? 0).toFixed(1)),
          p90AgeDays: bucket.length === 0 ? null : Number((quantile(bucket.map((d) => d.ageDays), 0.9) ?? 0).toFixed(1)),
        };
      }),
      requirement: {
        text: 'Zero open defects of the highest importance at the gate; high-importance only with a workaround and accepted risk (Q8)',
        outcome: openCritical === 0 ? 'met' : 'violated',
      },
      caveats: [
        `Open backlog p90 age ${(quantile(ages, 0.9) ?? 0).toFixed(0)} days.`,
        'Convergence (arrival rate vs execution) needs test-execution data per release; supply CI/TMS results to enable G5.',
        ...degradedBy(this, ctx),
      ],
    });
  },
};

/** Q13 / M4.5. Reopen rate and defective-fix share. */
export const q13Reopen: MetricDefinition = {
  id: 'Q13',
  name: 'Reopen rate / fix quality',
  block: 'D. Process health',
  dependsOnFields: ['stateCategory'],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    // Denominator: defects that reached a resolved state in the period.
    // A reopened defect is currently active again, so `isResolved` would drop it.
    const resolved = ctx.defects.filter(
      (d) => d.raw.resolvedAt !== null || d.raw.closedAt !== null || d.isReopened,
    );
    if (resolved.length === 0) {
      return skeleton(this, { status: 'not-computable', caveats: ['No resolved defects in period.'] });
    }
    const reopened = resolved.filter((d) => d.isReopened);
    const rate = reopened.length / resolved.length;
    const max = ctx.profile.thresholds.reopenRateMax;
    const byModule = new Map<string, { total: number; reopened: number }>();
    for (const d of resolved) {
      const key = d.module ?? '(unassigned)';
      const cur = byModule.get(key) ?? { total: 0, reopened: 0 };
      cur.total += 1;
      if (d.isReopened) cur.reopened += 1;
      byModule.set(key, cur);
    }
    const fixDays = reopened.map((d) => d.fixDays).filter((x): x is number => x !== null);
    return skeleton(this, {
      status: 'computed',
      formulaVersion: 'v2 (state-category transitions)',
      value: rate,
      unit: 'share',
      breakdown: [...byModule.entries()]
        .filter(([, v]) => v.total >= 5)
        .sort((a, b) => b[1].reopened / b[1].total - a[1].reopened / a[1].total)
        .slice(0, 10)
        .map(([module, v]) => ({
          module,
          resolved: v.total,
          reopened: v.reopened,
          rate: Number((v.reopened / v.total).toFixed(3)),
        })),
      requirement: {
        text: `Reopen rate <= ${(max * 100).toFixed(0)}% [orientation] and no growth signal`,
        outcome: rate <= max ? 'met' : 'violated',
      },
      caveats: [
        `n=${resolved.length} resolved; ${reopened.length} reopened.`,
        fixDays.length > 0
          ? `Median time-to-fix of reopened defects: ${(median(fixDays) ?? 0).toFixed(1)}d - short times here mean rushed fixes (Q13 x M4.4).`
          : 'No fix durations available for reopened defects.',
        'v1 (reopen OR fix commit is bug-inducing for another defect) needs SZZ from document 03.',
      ],
    });
  },
};

/** M4.4. Fix response time and percent delinquent fixes. */
export const m44FixResponse: MetricDefinition = {
  id: 'M4.4',
  name: 'Fix response time and % delinquent fixes',
  block: 'D. Process health',
  dependsOnFields: ['priority'],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const levels: readonly string[] = ['critical', 'high', 'medium', 'low'];
    const rows: Record<string, string | number | null>[] = [];
    let delinquent = 0;
    let counted = 0;
    for (const lvl of levels) {
      const target = ctx.profile.fixTargetDays[lvl];
      const bucket = ctx.defects.filter((d) => d.imp === lvl);
      const closedDays = bucket.filter((d) => d.isResolved).map((d) => d.fixDays).filter((x): x is number => x !== null);
      const openOverTarget =
        target === undefined ? 0 : bucket.filter((d) => !d.isResolved && d.ageDays > target).length;
      const late = target === undefined ? 0 : closedDays.filter((x) => x > target).length;
      delinquent += late + openOverTarget;
      counted += closedDays.length + bucket.filter((d) => !d.isResolved).length;
      rows.push({
        importance: lvl,
        targetDays: target ?? null,
        medianFixDays: closedDays.length === 0 ? null : Number((median(closedDays) ?? 0).toFixed(1)),
        p90FixDays: closedDays.length === 0 ? null : Number((quantile(closedDays, 0.9) ?? 0).toFixed(1)),
        closed: closedDays.length,
        openPastTarget: openOverTarget,
      });
    }
    const rate = counted === 0 ? null : delinquent / counted;
    return skeleton(this, {
      status: 'computed',
      formulaVersion: 'v2 (median over closed + open-past-target counted separately)',
      value: rate,
      unit: 'share',
      breakdown: rows,
      requirement: {
        text: 'Fix response time within the per-importance target set in the profile',
        outcome: rate === null ? 'unknown' : rate <= 0.2 ? 'met' : 'violated',
      },
      caveats: [
        'Open defects are censored observations. The median over closed defects understates real time-to-fix; v1 (Kaplan-Meier) is the reference method and is not yet implemented.',
      ],
    });
  },
};

/** M4.6. Backlog Management Index. */
export const m46Bmi: MetricDefinition = {
  id: 'M4.6',
  name: 'Backlog Management Index (BMI)',
  block: 'D. Process health',
  dependsOnFields: ['stateCategory'],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const months = new Map<string, { opened: number; closed: number }>();
    const key = (iso: string): string => iso.slice(0, 7);
    for (const d of ctx.defects) {
      const k = key(d.tDet);
      const cur = months.get(k) ?? { opened: 0, closed: 0 };
      cur.opened += 1;
      months.set(k, cur);
      const end = d.raw.resolvedAt ?? d.raw.closedAt;
      if (end !== null) {
        const ck = key(end);
        const c = months.get(ck) ?? { opened: 0, closed: 0 };
        c.closed += 1;
        months.set(ck, c);
      }
    }
    const ordered = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const series: SeriesPoint[] = ordered
      .filter(([, v]) => v.opened > 0)
      .map(([label, v]) => ({ label, value: (v.closed / v.opened) * 100, mature: true, n: v.opened }));
    const last = series.slice(-3);
    const shrinking = last.length > 0 && last.every((p) => p.value >= 100);
    return skeleton(this, {
      status: 'computed',
      value:
        series.length === 0
          ? null
          : series.slice(-3).reduce((a, p) => a + p.value, 0) / series.slice(-3).length,
      unit: 'percent',
      series,
      breakdown: ordered.map(([month, v]) => ({
        month,
        opened: v.opened,
        closed: v.closed,
        bmi: v.opened === 0 ? null : Number(((v.closed / v.opened) * 100).toFixed(0)),
      })),
      requirement: {
        text: 'BMI >= 100% sustained; below 100% for several periods means a growing defect backlog',
        outcome: shrinking ? 'met' : 'violated',
      },
      caveats: ['Read together with p90 age of the open backlog (Q7): BMI < 100 plus rising p90 age is accumulating technical debt.'],
    });
  },
};

/** M4.9. Lag between detection and the first sprint the fix was planned into. */
export const m49FixPlanLag: MetricDefinition = {
  id: 'M4.9',
  name: 'Time to fix planning (FixPlanLag)',
  block: 'D. Process health',
  dependsOnFields: ['iterationPath'],
  dependsOnSources: ['defects', 'sprints'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const sprints = [...ctx.snapshot.sprints].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const indexOf = new Map(sprints.map((s, i) => [s.name, i]));
    const sprintAt = (iso: string): number | null => {
      const t = Date.parse(iso);
      const idx = sprints.findIndex((s) => Date.parse(s.startsAt) <= t && t <= Date.parse(s.endsAt));
      return idx === -1 ? null : idx;
    };
    const lags: number[] = [];
    for (const d of ctx.defects) {
      const planned = d.raw.history.find((h) => h.field === 'iterationPath' && h.to !== null)?.to ?? d.raw.iterationPath;
      if (planned === null) continue;
      const plannedIdx = indexOf.get(planned);
      const detIdx = sprintAt(d.tDet);
      if (plannedIdx === undefined || detIdx === null) continue;
      lags.push(plannedIdx - detIdx);
    }
    if (lags.length === 0) {
      return skeleton(this, { status: 'not-computable', caveats: ['No defect could be mapped to both a detection sprint and a planned sprint.'] });
    }
    return skeleton(this, {
      status: 'computed',
      formulaVersion: 'v1 (first non-empty iteration path from history)',
      value: median(lags),
      unit: 'count',
      breakdown: [
        { statistic: 'median sprints', value: Number((median(lags) ?? 0).toFixed(1)) },
        { statistic: 'p90 sprints', value: Number((quantile(lags, 0.9) ?? 0).toFixed(1)) },
        { statistic: 'share planned in detection sprint', value: Number((lags.filter((x) => x <= 0).length / lags.length).toFixed(2)) },
        { statistic: 'n', value: lags.length },
      ],
      requirement: { text: 'Project SMART target; measures reaction speed, not defect lifetime', outcome: 'unknown' },
      caveats: ['Do not confuse with defect lifetime (A13). This measures how long a defect waits for a decision.'],
    });
  },
};
