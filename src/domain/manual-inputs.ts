/**
 * Facts the pipeline cannot collect because they are DECISIONS, not measurements.
 * They live as JSON under version control. The tool's job is to check that they
 * exist, are complete and are signed - never to invent them.
 */

import type { Iso } from './types.js';

export type RiskLevel = 'high' | 'medium' | 'low';
export type CoverageOutcome = 'passed' | 'failed' | 'untested' | 'partial';

export interface RiskItem {
  readonly id: string;
  readonly description: string;
  /** TM 1.3.3: level is derived from likelihood x impact, both 1..5. */
  readonly likelihood: number;
  readonly impact: number;
  /** Tests covering this risk. Empty array = untested, and that is the point. */
  readonly tests: readonly string[];
  readonly outcome: CoverageOutcome;
  readonly owner: string | null;
}

export interface RequirementItem {
  readonly id: string;
  readonly title: string;
  readonly critical: boolean;
  readonly tests: readonly string[];
  readonly outcome: CoverageOutcome;
}

export interface RiskRegister {
  readonly release: string;
  readonly reviewedAt: Iso;
  readonly participants: readonly string[];
  readonly risks: readonly RiskItem[];
  readonly requirements: readonly RequirementItem[];
}

export interface ResidualRiskItem {
  readonly id: string;
  readonly description: string;
  readonly level: RiskLevel;
  readonly workaround: string | null;
  /** Empty or null = an unnamed risk shipped. That is the one inadmissible case. */
  readonly acceptedBy: string | null;
  readonly acceptedAt: Iso | null;
}

export interface GateDecision {
  readonly release: string;
  readonly decidedAt: Iso;
  readonly decision: 'ship' | 'ship-with-accepted-risk' | 'hold';
  readonly residualRisks: readonly ResidualRiskItem[];
  readonly testCompletionReportUrl: string | null;
}

/** PAF model (TM 3.2.1). Values are period totals in the project's currency. */
export interface CostModel {
  readonly period: { readonly from: Iso; readonly to: Iso };
  readonly currency: string;
  readonly prevention: number;
  readonly appraisal: number;
  readonly internalFailure: number;
  readonly externalFailure: number;
  /** Optional override; otherwise taken from the tracker. */
  readonly defectsBeforeRelease?: number;
  readonly defectsAfterRelease?: number;
  readonly estimated: boolean;
}

export interface ManualInputs {
  readonly riskRegister: RiskRegister | null;
  readonly gateDecision: GateDecision | null;
  readonly costModel: CostModel | null;
  /** Paths that were configured but could not be read, with the reason. */
  readonly loadErrors: readonly string[];
}

export const EMPTY_MANUAL_INPUTS: ManualInputs = {
  riskRegister: null,
  gateDecision: null,
  costModel: null,
  loadErrors: [],
};

export function riskLevel(item: RiskItem): RiskLevel {
  const score = item.likelihood * item.impact;
  if (score >= 15) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}
