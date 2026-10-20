import {
  WORLD_PLAN_SCHEMA_VERSION,
  validateWorldPlan,
  worldPlanSchema,
  type ValidationIssue,
  type WorldPlan,
} from './schema';

export class WorldPlanValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'WorldPlanValidationError';
    this.issues = issues;
  }
}

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registered upgrades keyed by the version they migrate FROM.
 * Phase 1 has no older public versions, so the registry is intentionally empty.
 * When v2 ships, add `1: (doc) => ({ ...doc, schemaVersion: 2, ... })` here.
 */
const MIGRATIONS: Record<number, Migration> = {};

function readVersion(input: unknown): number | null {
  if (typeof input !== 'object' || input === null) return null;
  const version = (input as Record<string, unknown>).schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) ? version : null;
}

/** Upgrade an untrusted document to the current schema version, or throw. */
export function migrateWorldPlan(input: unknown): unknown {
  let document: unknown = input;
  let version = readVersion(document);

  if (version === null) {
    throw new WorldPlanValidationError(
      'This file is missing a schemaVersion field, so it is not a WorldPlan document.',
    );
  }

  if (version > WORLD_PLAN_SCHEMA_VERSION) {
    throw new WorldPlanValidationError(
      `This world was saved with a newer format (v${version}). This app supports up to v${WORLD_PLAN_SCHEMA_VERSION}.`,
    );
  }

  while (version < WORLD_PLAN_SCHEMA_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new WorldPlanValidationError(
        `No migration is available from schema v${version} to v${WORLD_PLAN_SCHEMA_VERSION}.`,
      );
    }
    document = migration(document as Record<string, unknown>);
    const nextVersion = readVersion(document);
    if (nextVersion === null || nextVersion <= version) {
      throw new WorldPlanValidationError(`Migration from v${version} produced an invalid version.`);
    }
    version = nextVersion;
  }

  return document;
}

/** Validate any object as a current-version WorldPlan, throwing on failure. */
export function parseWorldPlan(input: unknown): WorldPlan {
  const result = validateWorldPlan(migrateWorldPlan(input));
  if (!result.success || !result.data) {
    const details = result.issues
      .slice(0, 4)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new WorldPlanValidationError(
      `The world file is not valid${details ? ` (${details})` : ''}.`,
      result.issues,
    );
  }
  return result.data;
}

/** Stable, human-readable project JSON. Unknown fields are stripped. */
export function serializeWorldPlan(plan: WorldPlan): string {
  const validated = worldPlanSchema.parse(plan);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function deserializeWorldPlan(json: string): WorldPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WorldPlanValidationError('The file is not valid JSON.');
  }
  return parseWorldPlan(parsed);
}
