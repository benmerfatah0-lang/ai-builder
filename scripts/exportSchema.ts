/**
 * Exports the WorldPlan Zod schema as JSON Schema (draft 2020-12) so external
 * tools — Godot/Unity importers, CLI validators, future backend services — can
 * validate project files without importing the app.
 *
 * Run with: npm run schema:export
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { worldPlanSchema } from '../src/core/world-plan/schema';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'docs/worldplan.schema.json');

const jsonSchema = z.toJSONSchema(worldPlanSchema, {
  target: 'draft-2020-12',
  io: 'output',
});

const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ai-world-builder.local/schemas/worldplan-v1.json',
  title: 'AI World Builder — WorldPlan v1',
  description:
    'Versioned world document produced by AI World Builder. Schema version 1.',
  ...jsonSchema,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
