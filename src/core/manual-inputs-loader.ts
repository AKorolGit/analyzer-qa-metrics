import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectProfile } from '../domain/profile.js';
import {
  EMPTY_MANUAL_INPUTS,
  type CostModel,
  type GateDecision,
  type ManualInputs,
  type RiskRegister,
} from '../domain/manual-inputs.js';

async function readJson<T>(path: string | undefined, errors: string[]): Promise<T | null> {
  if (path === undefined || path === '') return null;
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as T;
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : 'unreadable'}`);
    return null;
  }
}

export async function loadManualInputs(profile: ProjectProfile): Promise<ManualInputs> {
  const inputs = profile.manualInputs;
  if (inputs === undefined) return EMPTY_MANUAL_INPUTS;
  const loadErrors: string[] = [];
  const [riskRegister, gateDecision, costModel] = await Promise.all([
    readJson<RiskRegister>(inputs.riskRegisterPath, loadErrors),
    readJson<GateDecision>(inputs.gateDecisionPath, loadErrors),
    readJson<CostModel>(inputs.costOfQualityPath, loadErrors),
  ]);
  return { riskRegister, gateDecision, costModel, loadErrors };
}
