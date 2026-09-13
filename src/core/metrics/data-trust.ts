import { type MetricDefinition, degradedBy, gate, skeleton } from './contract.js';
import { wilson } from '../stats/index.js';

/** Q1. Completeness of mandatory defect attributes (CTAL-TM 2.3.5). */
export const q1Completeness: MetricDefinition = {
  id: 'Q1',
  name: 'Mandatory defect attribute completeness',
  block: 'A. Data trust',
  dependsOnFields: [],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const mandatory = ctx.fitness.fields.filter((f) => f.mandatory);
    const worst = mandatory.reduce<string>((acc, f) => {
      const cur = mandatory.find((x) => x.field === acc);
      return cur === undefined || f.completeness < cur.completeness ? f.field : acc;
    }, mandatory[0]?.field ?? '');
    const target = ctx.profile.thresholds.completenessMin;
    return skeleton(this, {
      status: 'computed',
      formulaVersion: ctx.profile.versions.completeness,
      value: ctx.fitness.q1,
      unit: 'share',
      breakdown: ctx.fitness.fields.map((f) => ({
        field: f.field,
        mandatory: f.mandatory ? 'yes' : 'no',
        completeness: Number(f.completeness.toFixed(3)),
        dominantValue: f.dominantValue,
        dominantShare: Number(f.dominantShare.toFixed(3)),
        verdict: f.verdict,
        reasons: f.reasons.join(' | ') || null,
      })),
      requirement: {
        text: `Q1 >= ${(target * 100).toFixed(0)}% on new defects; severity and priority both mandatory`,
        outcome: ctx.fitness.q1 >= target ? 'met' : 'violated',
      },
      caveats: [
        `Weakest mandatory field: ${worst}.`,
        ...(ctx.fitness.fields.some((f) => f.field === 'severity' && f.completeness < 0.5)
          ? ['Severity is not maintained. This is a gap against CTAL-TM 2.3.5, not a project peculiarity. Imp falls back to Priority (D7).']
          : []),
      ],
    });
  },
};

/** Q2. Rejected / duplicate / no-repro share (CTAL-TM 2.3.6). */
export const q2ReportQuality: MetricDefinition = {
  id: 'Q2',
  name: 'Defect report quality (rejected, duplicate, no-repro)',
  block: 'A. Data trust',
  dependsOnFields: ['resolution'],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const blocked = gate(this, ctx);
    if (blocked !== null) return blocked;
    const closed = ctx.defects.filter((d) => d.isClosed || d.isResolved);
    if (closed.length === 0) {
      return skeleton(this, { status: 'not-computable', caveats: ['No closed defects in period.'] });
    }
    const rejected = closed.filter((d) => d.isRejected).length;
    const duplicate = closed.filter((d) => d.isDuplicate).length;
    const noRepro = closed.filter((d) => d.isNoRepro).length;
    const total = rejected + duplicate + noRepro;
    const share = total / closed.length;
    const ci = wilson(total, closed.length);
    const max = ctx.profile.thresholds.badReportShareMax;
    return skeleton(this, {
      status: degradedBy(this, ctx).length > 0 ? 'degraded' : 'computed',
      value: share,
      unit: 'share',
      breakdown: [
        { part: 'rejected', count: rejected, share: Number((rejected / closed.length).toFixed(3)) },
        { part: 'duplicate', count: duplicate, share: Number((duplicate / closed.length).toFixed(3)) },
        { part: 'no-repro', count: noRepro, share: Number((noRepro / closed.length).toFixed(3)) },
        { part: 'closed total', count: closed.length, share: 1 },
      ],
      requirement: {
        text: `Sum of the three shares does not grow quarter over quarter; above ${(max * 100).toFixed(0)}% [orientation] warrants investigation`,
        outcome: share <= max ? 'met' : 'violated',
      },
      caveats: [
        `95% CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}% on n=${closed.length}.`,
        ...degradedBy(this, ctx),
      ],
    });
  },
};

/** Q3. Traceability - forward and backward (CTAL-TM 1.6.5). */
export const q3Traceability: MetricDefinition = {
  id: 'Q3',
  name: 'Traceability: defects <-> requirements / tests / code',
  block: 'A. Data trust',
  dependsOnFields: ['links'],
  dependsOnSources: ['defects'],
  compute(ctx) {
    const total = ctx.defects.length;
    if (total === 0) return skeleton(this, { status: 'not-computable', caveats: ['No defects.'] });
    const withReq = ctx.defects.filter((d) =>
      d.raw.links.some((l) => /parent|requirement|story|feature|epic|pbi/i.test(l.type)),
    ).length;
    const withCode = ctx.defects.filter(
      (d) => d.raw.commits.length > 0 || d.raw.pullRequests.length > 0,
    ).length;
    const backward = withReq / total;
    const codeLink = withCode / total;
    return skeleton(this, {
      status: 'computed',
      formulaVersion: 'v1 (tracker links)',
      value: backward,
      unit: 'share',
      breakdown: [
        { direction: 'backward: defect -> requirement/story', share: Number(backward.toFixed(3)), n: withReq },
        { direction: 'defect -> commit/PR (enables document 03)', share: Number(codeLink.toFixed(3)), n: withCode },
        { direction: 'forward: risk/requirement -> test', share: null, n: null },
      ],
      requirement: {
        text: '100% of high-level risks and critical requirements have >= 1 test; code linkage >= 25% without significant skew before any code-archaeology conclusion',
        outcome: 'unknown',
      },
      caveats: [
        'Forward traceability needs a risk register and a TMS. Neither is collectable from the tracker - supply it as manual input (Q4).',
        codeLink < 0.25
          ? `Code linkage ${(codeLink * 100).toFixed(0)}% < 25%: defect-density and hotspot conclusions from document 03 are not admissible yet.`
          : `Code linkage ${(codeLink * 100).toFixed(0)}% clears the 25% precondition; still check for skew across modules.`,
      ],
    });
  },
};
