import type { MetricContext, MetricDefinition, MetricResult } from './contract.js';
import { q1Completeness, q2ReportQuality, q3Traceability } from './data-trust.js';
import {
  m44FixResponse,
  m46Bmi,
  m49FixPlanLag,
  q10FieldDefects,
  q13Reopen,
  q7OpenDefects,
  q9Ddp,
} from './defect-flow.js';
import {
  m43ChangeFailure,
  q14Clusters,
  q15Containment,
  q16RegressionCapability,
} from './product-and-delivery.js';
import {
  gateChecklist,
  q17CostOfQuality,
  q4RiskCoverage,
  q5RequirementCoverage,
  q8ResidualRisk,
} from './gate.js';
import { declaredMetrics } from './declared.js';

/** Order matters: data trust first. Everything downstream depends on it. */
export const registry: readonly MetricDefinition[] = [
  q1Completeness,
  q2ReportQuality,
  q3Traceability,
  q4RiskCoverage,
  q5RequirementCoverage,
  q7OpenDefects,
  q8ResidualRisk,
  q9Ddp,
  q10FieldDefects,
  q13Reopen,
  q14Clusters,
  q15Containment,
  q16RegressionCapability,
  q17CostOfQuality,
  m43ChangeFailure,
  m44FixResponse,
  m46Bmi,
  m49FixPlanLag,
  gateChecklist,
  ...declaredMetrics,
];

export function computeAll(ctx: MetricContext): readonly MetricResult[] {
  return registry.map((def) => {
    try {
      return def.compute(ctx);
    } catch (error) {
      return {
        id: def.id,
        name: def.name,
        block: def.block,
        status: 'not-computable' as const,
        formulaVersion: 'n/a',
        value: null,
        unit: 'none' as const,
        series: [],
        breakdown: [],
        requirement: { text: '', outcome: 'unknown' as const },
        caveats: [`Computation failed: ${error instanceof Error ? error.message : String(error)}`],
        dependsOnFields: def.dependsOnFields,
      };
    }
  });
}
