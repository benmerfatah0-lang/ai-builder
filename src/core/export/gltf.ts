import { buildWorldScene, disposeObject3D } from '../scene/sceneBuilder';
import type { WorldPlan } from '../world-plan/schema';
import { WORLD_FILE_EXTENSION } from '../persistence/projectFile';

export interface GlbExportResult {
  buffer: ArrayBuffer;
  bytes: number;
  objectCount: number;
}

export function suggestGlbFileName(plan: WorldPlan): string {
  const slug = plan.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'world'}.glb`;
}

/**
 * Export the world as a self-contained binary glTF 2.0 file.
 *
 * glTF is an open Khronos standard and the format both Godot 4 and Unity's
 * glTF importers read. Geometry is generated from the same scene builder used
 * by the live viewport, so exports are faithful and require no server.
 */
export async function exportWorldToGlb(
  plan: WorldPlan,
  options: { includeHidden?: boolean; terrainResolutionCap?: number } = {},
): Promise<GlbExportResult> {
  const root = buildWorldScene(plan, {
    includeLights: false,
    includeHidden: options.includeHidden ?? false,
    maxPointLights: 0,
    terrainResolutionCap: options.terrainResolutionCap ?? 160,
  });

  try {
    // Loaded on demand: the exporter is only needed when a user exports.
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const output = await new GLTFExporter().parseAsync(root, {
      binary: true,
      onlyVisible: false,
      trs: true,
    });

    if (!(output instanceof ArrayBuffer)) {
      throw new Error('glTF exporter returned an unexpected non-binary result.');
    }

    return {
      buffer: output,
      bytes: output.byteLength,
      objectCount: plan.objects.filter((object) => options.includeHidden || object.visible).length,
    };
  } finally {
    disposeObject3D(root);
  }
}

/** Browser-only: download the .glb file. */
export async function downloadWorldGlb(
  plan: WorldPlan,
  options: { includeHidden?: boolean } = {},
): Promise<{ filename: string; bytes: number }> {
  const result = await exportWorldToGlb(plan, options);
  const filename = suggestGlbFileName(plan);
  const blob = new Blob([result.buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename, bytes: result.bytes };
}

export interface ExportTarget {
  id: string;
  label: string;
  format: string;
  extension: string;
  consumers: string[];
  description: string;
}

/** What the app can genuinely produce today. No placeholder targets. */
export const EXPORT_TARGETS: ExportTarget[] = [
  {
    id: 'project',
    label: 'Project file',
    format: 'WorldPlan JSON v1',
    extension: WORLD_FILE_EXTENSION,
    consumers: ['AI World Builder'],
    description: 'Full lossless project: terrain, objects, colors and AI generation metadata.',
  },
  {
    id: 'glb',
    label: '3D model',
    format: 'glTF 2.0 binary',
    extension: '.glb',
    consumers: ['Godot 4', 'Unity'],
    description:
      'Geometry, materials and vertex colors. Godot imports glTF natively; Unity needs any free glTF importer.',
  },
];
