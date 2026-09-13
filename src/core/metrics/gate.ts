import { type MetricDefinition, skeleton } from './contract.js';
import { riskLevel } from '../../domain/manual-inputs.js';
import { cohortViews } from './defect-flow.js';

const MISSING_REGISTER =
  'No risk register supplied. Set manualInputs.riskRegisterPath in the profile. A gate that cannot name what is untested is not a gate.';

/** Q4. Product risk coverage - the main risk-based-testing gate metric (TM 2.1.3). */
export const q4RiskCoverage: MetricDefinition = {
  id: 'Q4',
  name: 'Product risk coverage',
  block: 'B. Release gate',
  dependsOnFields: [],
  dependsOnSources: [],
  compute(ctx) {
    const register = ctx.manual.riskRegister;
    if (register === null) {
      return skeleton(this, {
        status: 'needs-manual-input',
        requirement: { text: 'High-level risks: Failed = 0 and Untested = 0, or residual risk accepted in Q8', outcome: 'unknown' },
        caveats: [MISSING_REGISTER, ...ctx.manual.loadErrors],
      });
    }
    const levels = ['high', 'medium', 'low'] as const;
    const rows = levels.map((level) => {
      const bucket = register.risks.filter((r) => riskLevel(r) === level);
      const n = Math.max(1, bucket.length);
      return {
        level,
        risks: bucket.length,
        passed: bucket.filter((r) => r.outcome === 'passed').length,
        failed: bucket.filter((r) => r.outcome === 'failed').length,
        untested: bucket.filter((r) => r.outcome === 'untested' || r.outcome === 'partial').length,
        passedShare: Number((bucket.filter((r) => r.outcome === 'passed').length / n).toFixed(2)),
      };
    });
    const high = register.risks.filter((r) => riskLevel(r) === 'high');
    const highFailed = high.filter((r) => r.outcome === 'failed');
    const highUntested = high.filter((r) => r.outcome === 'untested' || r.outcome === 'partial');
    const accepted = new Set((ctx.manual.gateDecision?.residualRisks ?? []).filter((r) => r.acceptedBy !== null).map((r) => r.id));
    const unaccounted = [...highFailed, ...highUntested].filter((r) => !accepted.has(r.id));
    const noOwner = register.risks.filter((r) => r.owner === null).length;

    return skeleton(this, {
      status: 'computed',
      formulaVersion: 'v1 (risk register with likelihood x impact)',
      // Headline is the UNACCOUNTED share, not the raw untested share: an
      // untested risk with a signed acceptance is a decision, not a gate breach.
      value: high.length === 0 ? null : unaccounted.length / high.length,
      unit: 'share',
      breakdown: [
        ...rows,
        {
          level: 'high risks failed or untested (raw)',
          risks: highFailed.length + highUntested.length,
          passed: null,
          failed: highFailed.length,
          untested: highUntested.length,
          passedShare: null,
        },
        {
          level: 'of those, UNACCOUNTED (no acceptance in Q8)',
          risks: unaccounted.length,
          passed: null,
          failed: null,
          untested: null,
          passedShare: null,
        },
      ],
      requirement: {
        text: 'For high-level risks Failed = 0 and Untested = 0, or residual risk explicitly accepted by an owner',
        outcome: unaccounted.length === 0 ? 'met' : 'violated',
      },
      caveats: [
        unaccounted.length > 0
          ? `${unaccounted.length} high-level risk(s) are failed or untested and carry no acceptance: ${unaccounted.slice(0, 5).map((r) => r.id).join(', ')}.`
          : 'Every high-level risk is either passed or has an accepted residual risk.',
        noOwner > 0 ? `${noOwner} risk(s) have no owner - likelihood was assessed by nobody in particular.` : '',
        register.participants.length < 2
          ? 'Fewer than two participants recorded for the risk session. TM 1.3.6 asks whether the relevant stakeholders were involved; on this evidence the answer is no.'
          : `Risk session participants: ${register.participants.join(', ')}.`,
      ].filter((s) => s !== ''),
    });
  },
};

/** Q5. Requirements coverage (TM 2.1.3, ITP 4.4.6.2). */
export const q5RequirementCoverage: MetricDefinition = {
  id: 'Q5',
  name: 'Requirements coverage',
  block: 'B. Release gate',
  dependsOnFields: [],
  dependsOnSources: [],
  compute(ctx) {
    const register = ctx.manual.riskRegister;
    if (register === null || register.requirements.length === 0) {
      return skeleton(this, {
        status: 'needs-manual-input',
        requirement: { text: 'Critical requirements tested&passed = 100%, or accepted in Q8', outcome: 'unknown' },
        caveats: [
          'No requirement list supplied. The cheapest v2 is tags in the automation code (@req:US-481) exported alongside the run - that makes this collectable instead of manual.',
        ],
      });
    }
    const all = register.requirements;
    const critical = all.filter((r) => r.critical);
    const tested = (xs: typeof all): number => xs.filter((r) => r.outcome !== 'untested').length;
    const passed = (xs: typeof all): number => xs.filter((r) => r.outcome === 'passed').length;
    const criticalGap = critical.length - passed(critical);
    return skeleton(this, {
      status: 'computed',
      value: all.length === 0 ? null : passed(all) / all.length,
      unit: 'share',
      breakdown: [
        { scope: 'all requirements', total: all.length, tested: tested(all), testedAndPassed: passed(all) },
        { scope: 'critical requirements', total: critical.length, tested: tested(critical), testedAndPassed: passed(critical) },
      ],
      requirement: {
        text: 'Critical requirements: tested&passed = 100%',
        outcome: criticalGap === 0 ? 'met' : 'violated',
      },
      caveats: [
        criticalGap > 0 ? `${criticalGap} critical requirement(s) are not both tested and passed.` : '',
        'Coverage counts requirements, not behaviours. For compound requirements count atomic conditions instead (AuT 4.2.4), or this number flatters the release.',
      ].filter((s) => s !== ''),
    });
  },
};

/** Q8. Residual risk and the release decision (TM 1.1.3, 3.2.2). */
export const q8ResidualRisk: MetricDefinition = {
  id: 'Q8',
  name: 'Residual risk and the release decision',
  block: 'B. Release gate',
  dependsOnFields: [],
  dependsOnSources: [],
  compute(ctx) {
    const decision = ctx.manual.gateDecision;
    if (decision === null) {
      return skeleton(this, {
        status: 'needs-manual-input',
        requirement: { text: '0 high-level residual items without an owner signature', outcome: 'unknown' },
        caveats: [
          'No gate decision file supplied. Shipping with an accepted risk is allowed; shipping with an unnamed one is not - and with no record there is no way to tell which happened.',
        ],
      });
    }
    const unsigned = decision.residualRisks.filter((r) => r.level === 'high' && (r.acceptedBy === null || r.acceptedBy === ''));
    const noWorkaround = decision.residualRisks.filter((r) => r.level === 'high' && (r.workaround === null || r.workaround === ''));
    return skeleton(this, {
      status: 'computed',
      value: unsigned.length,
      unit: 'count',
      breakdown: decision.residualRisks.map((r) => ({
        id: r.id,
        level: r.level,
        workaround: r.workaround ?? '—',
        acceptedBy: r.acceptedBy ?? 'UNSIGNED',
        acceptedAt: r.acceptedAt ?? '—',
      })),
      requirement: {
        text: '0 high-level residual items without an owner signature',
        outcome: unsigned.length === 0 ? 'met' : 'violated',
      },
      caveats: [
        `Decision recorded as "${decision.decision}" on ${decision.decidedAt}.`,
        unsigned.length > 0 ? `${unsigned.length} high-level item(s) shipped unsigned.` : '',
        noWorkaround.length > 0 ? `${noWorkaround.length} high-level item(s) have no workaround recorded.` : '',
        decision.testCompletionReportUrl === null
          ? 'No test completion report linked (G10 unmet).'
          : '',
      ].filter((s) => s !== ''),
    });
  },
};

/** Q17. Cost of quality, PAF model (TM 3.2.1-3.2.2). */
export const q17CostOfQuality: MetricDefinition = {
  id: 'Q17',
  name: 'Cost of quality (PAF)',
  block: 'E. Cost',
  dependsOnFields: [],
  dependsOnSources: [],
  compute(ctx) {
    const model = ctx.manual.costModel;
    if (model === null) {
      return skeleton(this, {
        status: 'needs-manual-input',
        requirement: { text: 'Computed quarterly; external failure costs show no growth signal', outcome: 'unknown' },
        caveats: ['No cost model supplied. Even an estimate produces the business case - that is the whole point of TM 3.2.1.'],
      });
    }
    const before = model.defectsBeforeRelease ?? ctx.defects.filter((d) => d.env !== 'prod').length;
    const after = model.defectsAfterRelease ?? ctx.defects.filter((d) => d.env === 'prod').length;
    const avgAppraisal = before === 0 ? 0 : model.appraisal / before;
    const avgInternal = before === 0 ? 0 : model.internalFailure / before;
    const avgExternal = after === 0 ? 0 : model.externalFailure / after;
    const savingsPerDefect = avgExternal - (avgAppraisal + avgInternal);
    const total = model.prevention + model.appraisal + model.internalFailure + model.externalFailure;
    const externalShare = total === 0 ? 0 : model.externalFailure / total;
    return skeleton(this, {
      status: 'computed',
      formulaVersion: model.estimated ? 'v2 (estimated category totals)' : 'v1 (TM 3.2.2 on per-defect averages)',
      value: savingsPerDefect,
      unit: 'none',
      breakdown: [
        { category: 'prevention', amount: model.prevention, currency: model.currency },
        { category: 'appraisal', amount: model.appraisal, currency: model.currency },
        { category: 'internal failure', amount: model.internalFailure, currency: model.currency },
        { category: 'external failure', amount: model.externalFailure, currency: model.currency },
        { category: 'TOTAL CoQ', amount: total, currency: model.currency },
        { category: 'average saving per defect caught before release', amount: Number(savingsPerDefect.toFixed(0)), currency: model.currency },
      ],
      requirement: {
        text: 'External failure costs show no growth signal; average saving per defect is reported to management',
        outcome: 'unknown',
      },
      caveats: [
        model.estimated ? 'Figures are estimates. Say so when presenting - an estimated business case is still a business case, a disguised one is not.' : '',
        `External failure is ${(externalShare * 100).toFixed(0)}% of total cost of quality.`,
        savingsPerDefect > 0
          ? `Each defect caught before release saves about ${savingsPerDefect.toFixed(0)} ${model.currency}. This is the number to take to management, not coverage percentages.`
          : 'Average saving per defect is not positive: on these figures, catching defects earlier does not pay. Check the cost model before repeating this to management.',
      ].filter((s) => s !== ''),
    });
  },
};

/** The minimum release gate checklist G1-G10 from the metric base. */
export const gateChecklist: MetricDefinition = {
  id: 'GATE',
  name: 'Minimum release gate checklist (G1-G10)',
  block: 'B. Release gate',
  dependsOnFields: [],
  dependsOnSources: [],
  compute(ctx) {
    const register = ctx.manual.riskRegister;
    const decision = ctx.manual.gateDecision;
    const openCritical = ctx.defects.filter((d) => !d.isResolved && d.imp === 'critical').length;
    const runs = ctx.snapshot.testRuns;
    const failures = runs.reduce((a, r) => a + r.failed, 0);
    const tas = runs.reduce((a, r) => a + r.tasFailures, 0);
    const views = cohortViews(ctx);
    const highRisks = (register?.risks ?? []).filter((r) => riskLevel(r) === 'high');
    const criticalReqs = (register?.requirements ?? []).filter((r) => r.critical);

    type Check = { id: string; criterion: string; metric: string; verdict: string };
    const checks: Check[] = [
      {
        id: 'G1',
        criterion: 'High risks tested and passed',
        metric: 'Q4',
        verdict: register === null ? 'NO DATA' : highRisks.every((r) => r.outcome === 'passed') ? 'pass' : 'FAIL',
      },
      {
        id: 'G2',
        criterion: 'Critical requirements met',
        metric: 'Q5',
        verdict: register === null || criticalReqs.length === 0 ? 'NO DATA' : criticalReqs.every((r) => r.outcome === 'passed') ? 'pass' : 'FAIL',
      },
      { id: 'G3', criterion: 'High-risk tests executed', metric: 'Q6', verdict: 'NO DATA' },
      { id: 'G4', criterion: 'No open critical defects', metric: 'Q7', verdict: openCritical === 0 ? 'pass' : 'FAIL' },
      {
        id: 'G5',
        criterion: 'Convergence: arrival rate falling at full execution',
        metric: 'Q7 x Q6',
        verdict: views.length < 2 ? 'NO DATA' : 'NO DATA',
      },
      { id: 'G6', criterion: 'Non-functional minimum (SLA, security)', metric: 'Q12', verdict: 'NO DATA' },
      {
        id: 'G7',
        criterion: 'Test signal is trustworthy (TAS failures do not dominate)',
        metric: 'Q6, Q16',
        verdict: runs.length === 0 ? 'NO DATA' : tas / Math.max(1, failures) <= 0.5 ? 'pass' : 'FAIL',
      },
      { id: 'G8', criterion: 'Contextual criteria (K1-K5)', metric: 'K', verdict: 'NO DATA' },
      {
        id: 'G9',
        criterion: 'Residual risk accepted and signed',
        metric: 'Q8',
        verdict:
          decision === null
            ? 'NO DATA'
            : decision.residualRisks.filter((r) => r.level === 'high' && r.acceptedBy === null).length === 0
              ? 'pass'
              : 'FAIL',
      },
      {
        id: 'G10',
        criterion: 'Test completion report produced and circulated',
        metric: 'TM 1.1.3',
        verdict: decision?.testCompletionReportUrl != null ? 'pass' : 'NO DATA',
      },
    ];
    const failed = checks.filter((c) => c.verdict === 'FAIL').length;
    const unknown = checks.filter((c) => c.verdict === 'NO DATA').length;
    return skeleton(this, {
      status: unknown === checks.length ? 'not-computable' : 'computed',
      value: failed,
      unit: 'count',
      breakdown: checks,
      requirement: {
        text: 'Every row passes, or the deviation is accepted in Q8',
        outcome: failed === 0 && unknown === 0 ? 'met' : failed > 0 ? 'violated' : 'unknown',
      },
      caveats: [
        `${failed} criterion(s) failed, ${unknown} cannot be evaluated on the available data.`,
        unknown > 0
          ? 'A gate with unevaluable rows is not a gate. Each NO DATA row is a release decision being made on assumption rather than evidence.'
          : '',
      ].filter((s) => s !== ''),
    });
  },
};
