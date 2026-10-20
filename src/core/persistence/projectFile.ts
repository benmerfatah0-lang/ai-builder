import {
  deserializeWorldPlan,
  deserializeWorldPlanLenient,
  serializeWorldPlan,
  type RepairResult,
} from '../world-plan/migrate';
import type { WorldPlan } from '../world-plan/schema';

export const WORLD_FILE_EXTENSION = '.world.json';

export function suggestWorldFileName(plan: WorldPlan): string {
  const slug = plan.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'world'}${WORLD_FILE_EXTENSION}`;
}

/** Browser-only: trigger a download of the project file. Returns the filename. */
export function downloadWorldPlan(plan: WorldPlan): string {
  const filename = suggestWorldFileName(plan);
  const json = serializeWorldPlan(plan);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next frame so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

export async function readWorldFile(file: File): Promise<WorldPlan> {
  const text = await file.text();
  return deserializeWorldPlan(text);
}

/** Import path for damaged or partially invalid files; reports what was skipped. */
export async function readWorldFileLenient(file: File): Promise<RepairResult> {
  const text = await file.text();
  return deserializeWorldPlanLenient(text);
}
