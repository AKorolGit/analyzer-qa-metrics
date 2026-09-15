import type { Iso, TrackerKind, VcsKind } from './types.js';

/**
 * D7 project profile. This file is THE input contract: it records which
 * version of every variable and formula this project can support.
 * If a version cannot be satisfied by the data, the metric degrades or
 * is refused - it is never silently computed on a worse definition.
 */

export type TDetVersion = 'v1' | 'v2';
export type EnvVersion = 'v1' | 'v2' | 'v3' | 'v4';
export type ImpVersion = 'v1' | 'v2' | 'v3' | 'v4';
export type ModuleVersion = 'v1' | 'v2' | 'v3';
export type CompletenessVersion = 'v1' | 'v2' | 'v3';
export type CohortVersion = 'v1' | 'v2' | 'v3';

export interface VersionSelection {
  readonly tDet: TDetVersion;
  readonly env: EnvVersion;
  /**
   * v1 Severity · v2 Priority at first triage · v3 current Priority
   * v4 Severity when it was actually set, otherwise Priority at triage.
   * Use v4 where the tracker writes a Severity default that nobody maintains:
   * a field filled 100% of the time by the tool carries no information.
   */
  readonly imp: ImpVersion;
  readonly module: ModuleVersion;
  readonly completeness: CompletenessVersion;
  /**
   * v1 version/sprint of detection · v2 dates only · v3 version corrected.
   * v1 accepts either a real version string or a sprint name, and maps the
   * sprint to the release its cycle fed.
   */
  readonly cohort: CohortVersion;
}

export interface EnvRules {
  /** v1: values of the environment / detection-activity field meaning production. */
  readonly prodFieldValues: readonly string[];
  /** v2: deliberately set tags meaning "found in production". */
  readonly prodTags: readonly string[];
  /**
   * v2: markers at the START of the title, e.g. "Prod. Cannot send invite".
   * Only the first few tokens are checked - a keyword search over the whole
   * description would turn "could not reproduce on prod-like env" into a
   * production defect, which is precisely the error this avoids.
   */
  readonly prodTitlePrefixes: readonly string[];
  /**
   * Title prefixes that positively mark a NON-production environment
   * ("Stage.", "QA.").
   *
   * These change closedWorld from a guess into a rule. Where a team prefixes
   * every defect found outside the development environment, an absent prefix
   * is itself evidence: it says "found on dev", not "nobody recorded where
   * this came from". Without them the classification comes out the same but
   * the report cannot tell a measured pre-release defect from an unrecorded
   * one, and has to caveat DDP accordingly.
   */
  readonly preReleaseTitlePrefixes?: readonly string[];
  /** How many leading tokens of the title may carry a marker. Default 2. */
  readonly titlePrefixTokens?: number;
  /** Delivery-channel tags that must NOT be read as detection activity (e.g. Hotfix). */
  readonly deliveryTags: readonly string[];
  /** v3: creator accounts / channels that only file production issues. */
  readonly prodCreators: readonly string[];
  /** v4: keywords anywhere in the text. Lowest reliability - a last resort. */
  readonly prodKeywords: readonly string[];
  /**
   * Closed-world assumption: "no signal => not prod".
   *
   * On its own this is the most dangerous setting in the pipeline, because an
   * unmarked production defect silently counts as caught before release. It
   * stops being an assumption once preReleaseTitlePrefixes are configured and
   * the report shows the convention is actually followed.
   */
  readonly closedWorld: boolean;
}

/** A mapping from raw field values to the four importance levels. */
export interface ImportanceScale {
  readonly criticalValues: readonly string[];
  readonly highValues: readonly string[];
  readonly mediumValues: readonly string[];
  readonly lowValues: readonly string[];
  /** Value the tracker writes by itself. Treated as "not set" by Imp v4. */
  readonly defaultValue: string | null;
}

export interface ImportanceRules extends ImportanceScale {
  /**
   * Separate scale for Severity, used by Imp v1 and v4. Severity and Priority
   * almost never share a value vocabulary ("1 - Critical" vs "1"), and folding
   * them into one list silently misclassifies one of them.
   */
  readonly severity?: ImportanceScale;
}

export interface ResolutionRules {
  readonly rejected: readonly string[];
  readonly duplicate: readonly string[];
  readonly noRepro: readonly string[];
  readonly fixed: readonly string[];
}

export interface FieldPolicy {
  /** Field name in RawDefect. */
  readonly field: string;
  /** Tracker default value, used by completeness v1/v2 (D4.1). */
  readonly defaultValue: string | null;
  /** Mandatory per CTAL-TM 2.3.5 + manual additions. */
  readonly mandatory: boolean;
}

/**
 * Analysis scope. Applied AFTER collection, never during it: the snapshot stays
 * a complete record of what the tracker held, so the scope can be re-tuned and
 * the report regenerated without another API round trip.
 */
export interface ScopeRules {
  /** Regex on iterationPath. Use it when several teams share one project. */
  readonly iterationPathPattern?: string;
  /** Regex on areaPath. */
  readonly areaPathPattern?: string;
  /** RawDefect fields that must be non-empty for a defect to be in scope. */
  readonly requireFields?: readonly string[];
}

export interface Thresholds {
  /** Q1 >= 95% [orientation]. */
  readonly completenessMin: number;
  /** Q2: rejected+duplicate+norepro share above this warrants investigation. */
  readonly badReportShareMax: number;
  /** Q13 reopen rate. */
  readonly reopenRateMax: number;
  /** M4.5 fix quality. */
  readonly defectiveFixMax: number;
  /** Q16 flaky + TAS failure share. */
  readonly flakyRateMax: number;
  readonly tasFailureShareMax: number;
  /** D4: a field whose dominant value exceeds this is not discriminating. */
  readonly dominanceMax: number;
  /** M5/PCE: below this fill rate the conclusion describes only the filled part. */
  readonly causeFillMin: number;
  /** M4.7 regression cycles. */
  readonly regressionCyclesMax: number;
  /** A minimum cohort size below which percentages are refused. */
  readonly minCohortSize: number;
  /** Q9 DDP target from baseline; null = no target yet. */
  readonly ddpTarget: number | null;
  /**
   * Env markers that disagree more often than this share of the marked
   * population mean the convention is not followed consistently, and DDP
   * inherits that error. Default 0.2.
   */
  readonly envMarkerDisagreementMax?: number;
}

export interface ProjectProfile {
  readonly name: string;
  readonly tracker: {
    readonly kind: TrackerKind;
    readonly organization?: string;
    readonly project?: string;
    readonly baseUrl?: string;
    readonly jql?: string;
    readonly wiql?: string;
    /**
     * Reference names of custom fields on this instance. Discover them with
     * `npm run fields` rather than guessing - they differ per organisation.
     * An override naming a field that never appears in the data is reported
     * as a collection error, not silently resolved to null.
     */
    readonly fieldOverrides?: {
      readonly severity?: string;
      readonly rootCause?: string;
      readonly environment?: string;
      readonly repro?: string;
      /** Version or sprint the defect was found in - cohort attribution v1. */
      readonly versionDetected?: string;
      /** Version the fix shipped in - cohort attribution v3. */
      readonly versionCorrected?: string;
      readonly component?: string;
    };
    /** Fixture adapter only. */
    readonly fixturePath?: string;
  };
  readonly ci?: {
    readonly kind: 'azure-pipelines' | 'json-file' | 'fixture' | 'none';
    /** Directory of run summaries emitted by the Playwright / Cypress reporters. */
    readonly runSummaryDir?: string;
  };
  readonly vcs: {
    readonly kind: VcsKind;
    /** github only. */
    readonly owner?: string;
    readonly repo?: string;
    /** local-git only: path to a full (not shallow) clone. */
    readonly path?: string;
    /** Branch or ref to read. Omitted on local-git means all refs. */
    readonly branch?: string;
  };
  readonly period: { readonly from: Iso; readonly to: Iso };
  /** DDP / field-defect observation window W in days (ITP 4.4.2.1: 90 or 180). */
  readonly windowDays: number;
  readonly versions: VersionSelection;
  readonly env: EnvRules;
  readonly importance: ImportanceRules;
  readonly resolution: ResolutionRules;
  readonly scope?: ScopeRules;
  readonly fields: readonly FieldPolicy[];
  readonly thresholds: Thresholds;
  /** Target fix time per importance level, in days (M4.4 % delinquent). */
  readonly fixTargetDays: Readonly<Record<string, number>>;
  readonly releases: readonly {
    readonly version: string;
    readonly releasedAt: Iso;
    readonly klocChanged?: number;
    readonly storiesDelivered?: number;
  }[];
  readonly sprints: readonly {
    readonly name: string;
    readonly startsAt: Iso;
    readonly endsAt: Iso;
    readonly releaseVersion?: string;
  }[];
  /**
   * Facts the pipeline cannot collect: gate inputs, SLA, cost model.
   * Absent => the corresponding metric reports "not-computable", not "green".
   */
  readonly manualInputs?: {
    readonly riskRegisterPath?: string;
    readonly gateDecisionPath?: string;
    readonly costOfQualityPath?: string;
    readonly slaAvailability?: number;
  };
}