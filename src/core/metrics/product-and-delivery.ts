import { type MetricDefinition, degradedBy, gate, skeleton, type SeriesPoint } from './contract.js';

/** Q14. Defect clusters by component: share, density, Pareto (CTAL-TM 2.3.6). */
export const q14Clusters: MetricDefinition = {
  id: 'Q14',
  name: 'Defect clusters by module (share x density, Pareto)',
  block: 'D. Process health',
  // Not gated on `component`: the module is resolved through a fallback chain
  // (component -> areaPath -> owner), so a missing component is not a missing
  // module. Which field actually carried it is reported as a caveat, because a
  // cluster on an area path means something different from one on a component.
  dependsOnFields: [],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;

    const resolved = ctx.defects.filter((d) => d.module !== null);
    if (resolved.length === 0) {
      return skeleton(this, {
        status: 'not-computable',
        caveats: ['No defect carries a component, area path or owner - there is nothing to cluster by.'],
      });
    }
    const sources = new Map<string, number>();
    for (const d of resolved) sources.set(d.moduleSource, (sources.get(d.moduleSource) ?? 0) + 1);

    const churnByModule = new Map<string, number>();
    for (const c of ctx.snapshot.commits) {
      for (const f of c.files) {
        const mod = f.split('/')[0] ?? '(root)';
        churnByModule.set(mod, (churnByModule.get(mod) ?? 0) + c.linesAdded + c.linesDeleted);
      }
    }
    const counts = new Map<string, number>();
    for (const d of resolved) {
      const key = d.module as string;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const total = resolved.length;
    const rows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([module, n]) => {
        const churn = churnByModule.get(module) ?? churnByModule.get(module.split('\\').pop() ?? '') ?? null;
        const kloc = churn === null ? null : churn / 1000;
        return {
          module,
          defects: n,
          share: Number((n / total).toFixed(3)),
          klocChanged: kloc === null ? null : Number(kloc.toFixed(2)),
          densityPerKloc: kloc === null || kloc === 0 ? null : Number((n / kloc).toFixed(1)),
          fieldShare: Number(
            (
              resolved.filter((d) => d.module === module && d.env === 'prod').length / Math.max(1, n)
            ).toFixed(2),
          ),
        };
      });

    let cumulative = 0;
    let paretoCount = 0;
    for (const r of rows) {
      cumulative += r.share;
      paretoCount += 1;
      if (cumulative >= 0.8) break;
    }
    const densities = rows.map((r) => r.densityPerKloc).filter((x): x is number => x !== null);
    const spread = densities.length >= 2 ? Math.max(...densities) / Math.max(0.01, Math.min(...densities)) : null;
    const dominantSource = [...sources.entries()].sort((a, b) => b[1] - a[1])[0];

    return skeleton(this, {
      status: degradedBy(this, ctx).length > 0 || rows.length < 3 ? 'degraded' : 'computed',
      formulaVersion: `Module ${ctx.profile.versions.module} via ${dominantSource?.[0] ?? 'unknown'}`,
      value: paretoCount,
      unit: 'count',
      breakdown: rows.slice(0, 12),
      requirement: {
        text: 'Top-3 clusters each have an owner and an action in the risk register for the next quarter',
        outcome: 'unknown',
      },
      caveats: [
        `${paretoCount} of ${rows.length} modules account for ~80% of defects.`,
        dominantSource !== undefined && dominantSource[0] !== 'component'
          ? `Modules come from ${dominantSource[0]}, not a component field. Area paths follow team structure rather than code structure, so a cluster here names a team's territory - useful for ownership, weaker as evidence about the code.`
          : '',
        rows.length < 3
          ? `Only ${rows.length} distinct module(s): the grouping is too coarse to locate anything. A finer field would be needed before acting on this.`
          : '',
        spread === null
          ? 'No churn data matched these module names: density cannot be computed, only share. A large module that simply changes a lot will look like a hotspot.'
          : spread > 5
            ? `Density spread ${spread.toFixed(1)}x between modules - this is a point problem, not a systemic one.`
            : `Density spread ${spread.toFixed(1)}x - the problem looks systemic rather than localised.`,
        ...degradedBy(this, ctx),
      ].filter((s) => s !== ''),
    });
  },
};

/**
 * Q15 / M5 v2. Release containment by insertion activity.
 * Deliberately NOT called PCE: without detection activity this is containment.
 */
export const q15Containment: MetricDefinition = {
  id: 'Q15',
  name: 'Release containment by insertion activity (M5 v2)',
  block: 'D. Process health',
  // Deliberately not gated on rootCause: partial fill is handled inside as a
  // degraded result with an explicit bias warning, which is more useful than silence.
  dependsOnFields: [],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const withCause = ctx.defects.filter((d) => d.raw.rootCause !== null && d.raw.rootCause.trim() !== '');
    const fill = ctx.defects.length === 0 ? 0 : withCause.length / ctx.defects.length;
    const bucket = (cause: string): string => {
      const c = cause.toLowerCase();
      if (/requirement|spec|analysis|acceptance/.test(c)) return 'Requirements';
      if (/config|deploy|environment|infra|migration/.test(c)) return 'Configuration / Deployment';
      if (/third|3rd|integration|external|vendor/.test(c)) return 'External';
      if (/test|coverage|missed case/.test(c)) return 'Detection gap';
      return 'Design / Coding';
    };
    const matrix = new Map<string, { total: number; escaped: number }>();
    for (const d of withCause) {
      const key = bucket(d.raw.rootCause as string);
      const cur = matrix.get(key) ?? { total: 0, escaped: 0 };
      cur.total += 1;
      if (d.env === 'prod') cur.escaped += 1;
      matrix.set(key, cur);
    }
    const rows = [...matrix.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([activity, v]) => ({
        insertionActivity: activity,
        defects: v.total,
        share: Number((v.total / Math.max(1, withCause.length)).toFixed(3)),
        escapedToProd: v.escaped,
        containment: Number((1 - v.escaped / Math.max(1, v.total)).toFixed(3)),
      }));
    const reqShare = (matrix.get('Requirements')?.total ?? 0) / Math.max(1, withCause.length);
    const cfgShare = (matrix.get('Configuration / Deployment')?.total ?? 0) / Math.max(1, withCause.length);
    const minFill = ctx.profile.thresholds.causeFillMin;

    return skeleton(this, {
      status: fill < minFill ? 'degraded' : 'computed',
      formulaVersion: 'v2 (insertion activity x Env; not PCE)',
      value: reqShare,
      unit: 'share',
      breakdown: rows,
      requirement: {
        text: 'Insertion phase recorded at least for high-importance defects; every critical production defect has causal analysis with a prevention action',
        outcome: fill >= minFill ? 'unknown' : 'violated',
      },
      caveats: [
        `Root cause filled on ${(fill * 100).toFixed(0)}% of defects (threshold ${(minFill * 100).toFixed(0)}%). ${
          fill < minFill ? 'The conclusion describes only the filled subset and is likely biased towards high-priority defects.' : ''
        }`,
        reqShare > 0.25
          ? `Requirements account for ${(reqShare * 100).toFixed(0)}% of insertions: expanding regression will not help. This is a shift-left problem.`
          : '',
        cfgShare > 0.2
          ? `Configuration / deployment accounts for ${(cfgShare * 100).toFixed(0)}%: the problem is not in testing at all.`
          : '',
      ].filter((s) => s !== ''),
    });
  },
};

/** M4.3. DORA change failure rate and recovery time. */
export const m43ChangeFailure: MetricDefinition = {
  id: 'M4.3',
  name: 'Change failure rate and recovery time (DORA)',
  block: 'C. Field outcome',
  dependsOnFields: [],
  dependsOnSources: ['deployments'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const prod = ctx.snapshot.deployments.filter((d) => /prod/i.test(d.environment));
    if (prod.length === 0) {
      return skeleton(this, { status: 'not-computable', caveats: ['No production deployments collected.'] });
    }
    const failed = prod.filter((d) => d.isRollback || d.isHotfix || !d.succeeded);
    const cfr = failed.length / prod.length;
    const cycles = new Map<string, number>();
    for (const d of ctx.snapshot.deployments) {
      if (/prod/i.test(d.environment) || !d.succeeded || d.releaseId === null) continue;
      cycles.set(d.releaseId, (cycles.get(d.releaseId) ?? 0) + 1);
    }
    const cycleValues = [...cycles.values()];
    const avgCycles = cycleValues.length === 0 ? null : cycleValues.reduce((a, b) => a + b, 0) / cycleValues.length;
    const maxCycles = ctx.profile.thresholds.regressionCyclesMax;
    return skeleton(this, {
      status: 'computed',
      formulaVersion: 'v2 (unplanned patch / hotfix / rollback within window)',
      value: cfr,
      unit: 'share',
      breakdown: [
        { metric: 'production deployments', value: prod.length },
        { metric: 'failed deployments', value: failed.length },
        { metric: 'change failure rate', value: Number(cfr.toFixed(3)) },
        { metric: 'avg regression cycles per release (M4.7)', value: avgCycles === null ? null : Number(avgCycles.toFixed(1)) },
      ],
      requirement: {
        text: `No growth signal on CFR; regression cycles per release <= ${maxCycles} [orientation]`,
        outcome: avgCycles !== null && avgCycles > maxCycles ? 'violated' : 'unknown',
      },
      caveats: [
        avgCycles !== null && avgCycles > maxCycles
          ? `${avgCycles.toFixed(1)} test-environment deployments per release inside code freeze: change control effectively does not exist. This is an organisational fix, not a QA one.`
          : '',
      ].filter((s) => s !== ''),
    });
  },
};

/** Q16 / M6.1. Regression capability: automation, flakiness, TAS failures, duration. */
export const q16RegressionCapability: MetricDefinition = {
  id: 'Q16',
  name: 'Regression capability: flakiness, TAS failure share, duration',
  block: 'D. Process health',
  dependsOnFields: [],
  dependsOnSources: ['testRuns'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const runs = ctx.snapshot.testRuns;
    const totalRuns = runs.length;
    const flakyPipelines = runs.filter((r) => r.retriedToGreen > 0).length;
    const ftrPipeline = flakyPipelines / totalRuns;
    const failures = runs.reduce((a, r) => a + r.failed, 0);
    const tas = runs.reduce((a, r) => a + r.tasFailures, 0);
    const inconclusive = runs.reduce((a, r) => a + r.inconclusive, 0);
    const executed = runs.reduce((a, r) => a + r.total, 0);
    const tasShare = failures === 0 ? 0 : tas / failures;
    const durations = runs.map((r) => r.durationSeconds).sort((a, b) => a - b);
    const medianDuration = durations[Math.floor(durations.length / 2)] ?? 0;
    const series: SeriesPoint[] = runs
      .slice()
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
      .map((r) => ({
        label: r.startedAt.slice(0, 10),
        value: r.total === 0 ? 0 : r.passed / r.total,
        mature: true,
        n: r.total,
      }));
    const flakyMax = ctx.profile.thresholds.flakyRateMax;
    const tasMax = ctx.profile.thresholds.tasFailureShareMax;
    return skeleton(this, {
      status: 'computed',
      formulaVersion: 'FTR v2 (runner retry status), TAS share v1',
      value: ftrPipeline,
      unit: 'share',
      series,
      breakdown: [
        { metric: 'FTR_pipeline (failed then green on retry)', value: Number(ftrPipeline.toFixed(3)) },
        { metric: 'TAS failure share of all failures', value: Number(tasShare.toFixed(3)) },
        { metric: 'inconclusive results (TAE 7.1.3)', value: inconclusive },
        { metric: 'median regression wall-clock, minutes', value: Number((medianDuration / 60).toFixed(1)) },
        { metric: 'tests executed in period', value: executed },
      ],
      requirement: {
        text: `Flaky rate and TAS failure share <= ${(flakyMax * 100).toFixed(0)}% [orientation]; regression fits the release cadence`,
        outcome: ftrPipeline <= flakyMax && tasShare <= tasMax ? 'met' : 'violated',
      },
      caveats: [
        ftrPipeline > flakyMax
          ? 'Above the threshold the team stops reading red. Fix this before acting on any other CI signal.'
          : '',
        inconclusive > 0
          ? `${inconclusive} inconclusive results: tests that pass while asserting nothing. This is the most dangerous state because it looks green.`
          : '',
        'Watch skip/quarantine counts alongside FTR - stability can be "improved" by switching tests off.',
      ].filter((s) => s !== ''),
    });
  },
};