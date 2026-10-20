/**
 * Live playground for the marketing site.
 *
 * It imports the *real* prompt interpreter and the *real* generator from the
 * application source — no mock data, no API key, no server round-trip — then
 * draws a top-down map of the resulting WorldPlan on a canvas so visitors can
 * see what the pipeline produced.
 *
 * Bundled by `npm run site:demo` (esbuild) into `website/public/demo.js`.
 */
import { interpretPromptLocally } from '../../src/modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from '../../src/core/generation/generateWorld';
import type { WorldObject, WorldPlan } from '../../src/core/world-plan/schema';
import type {
  WorldDensity,
  WorldScale,
  WorldStyle,
} from '../../src/modules/ai/types';

type Report = ReturnType<typeof generateWorldPlanWithReport>;

interface HitTarget {
  object: WorldObject;
  x: number;
  y: number;
  radius: number;
}

const EXAMPLES: { label: string; prompt: string }[] = [
  {
    label: 'The acceptance farm',
    prompt:
      'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths',
  },
  {
    label: 'Farm + creek + bridge',
    prompt:
      'A large cartoon farm with a farmhouse, a barn, wheat fields, fences, trees and a river with a bridge',
  },
  {
    label: 'Night farm with lanterns',
    prompt:
      'A large cartoon farm with a farmhouse, a barn, a chicken coop, fences, trees and lanterns at night',
  },
  {
    label: 'Orchard at sunset',
    prompt: 'A small cartoon farm with a barn, a wheat field and an orchard at sunset',
  },
  {
    label: 'Pine forest',
    prompt: 'A misty pine forest at night with lanterns',
  },
  {
    label: 'Village on a hill',
    prompt: 'A cozy village on a hill with a river and a bridge at sunset',
  },
];

const KIND_LABEL: Record<string, string> = {
  building: 'Buildings',
  field: 'Fields',
  path: 'Paths',
  river: 'Rivers',
  bridge: 'Bridges',
  fence: 'Fences',
  tree: 'Trees',
  rock: 'Rocks',
  lantern: 'Lanterns',
  primitive: 'Primitives',
};

const KIND_COLOUR: Record<string, string> = {
  building: '#e2836b',
  field: '#e0b755',
  path: '#c4a273',
  river: '#5fa8c9',
  bridge: '#b98a55',
  fence: '#c9a977',
  tree: '#7fae55',
  rock: '#a5a396',
  lantern: '#ffc46b',
  primitive: '#b9b3a8',
};

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const form = requireElement<HTMLFormElement>('#playground-form');
const promptField = requireElement<HTMLTextAreaElement>('#prompt');
const seedField = requireElement<HTMLInputElement>('#seed');
const styleField = requireElement<HTMLSelectElement>('#style');
const scaleField = requireElement<HTMLSelectElement>('#scale');
const densityField = requireElement<HTMLSelectElement>('#density');
const statusLine = requireElement<HTMLElement>('#playground-status');
const statsRow = requireElement<HTMLElement>('#stats');
const breakdown = requireElement<HTMLElement>('#breakdown');
const notes = requireElement<HTMLElement>('#notes');
const jsonOutput = requireElement<HTMLElement>('#json');
const downloadButton = requireElement<HTMLButtonElement>('#download');
const shuffleButton = requireElement<HTMLButtonElement>('#shuffle');
const canvas = requireElement<HTMLCanvasElement>('#map');
const mapFigure = requireElement<HTMLElement>('#map-figure');
const mapCaption = requireElement<HTMLElement>('#map-caption');
const tooltip = requireElement<HTMLElement>('#map-tooltip');
const legend = requireElement<HTMLElement>('#legend');
const exampleList = requireElement<HTMLElement>('#examples');

function getContext2D(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
  return ctx;
}

const context = getContext2D(canvas);

let currentPlan: WorldPlan | null = null;
let hits: HitTarget[] = [];
let hoveredId: string | null = null;

// ------------------------------------------------------------------ examples

for (const example of EXAMPLES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = example.label;
  button.addEventListener('click', () => {
    promptField.value = example.prompt;
    void generate();
  });
  exampleList.append(button);
}

// --------------------------------------------------------------- generation

function numberFromInput(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.abs(Math.trunc(value)) >>> 0 : fallback;
}

function summariseKinds(plan: WorldPlan): [string, number][] {
  const counts = new Map<string, number>();
  for (const object of plan.objects) {
    counts.set(object.kind, (counts.get(object.kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderStats(report: Report): void {
  const { plan, warnings, validation } = report;
  const kinds = summariseKinds(plan);
  const solid = plan.objects.filter(
    (object) => object.kind === 'building' || object.kind === 'field',
  ).length;
  const area = Math.round(plan.terrain.size);

  statsRow.innerHTML = '';
  const cards: [string, string][] = [
    [String(plan.objects.length), 'objects'],
    [String(plan.groups.length), 'groups'],
    [String(kinds.length), 'object kinds'],
    [`${area} × ${area}`, 'terrain (m)'],
    [String(solid), 'buildings & fields'],
    [validation.valid ? 'valid' : 'needs repair', 'validation'],
  ];
  for (const [value, label] of cards) {
    const card = document.createElement('div');
    card.className = 'stat';
    const strong = document.createElement('strong');
    strong.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    card.append(strong, span);
    statsRow.append(card);
  }

  const max = kinds[0]?.[1] ?? 1;
  breakdown.innerHTML = '';
  for (const [kind, count] of kinds) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label"><i style="background:${KIND_COLOUR[kind] ?? '#9aa'}" aria-hidden="true"></i>${
        KIND_LABEL[kind] ?? kind
      }</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(
        4,
        (count / max) * 100,
      ).toFixed(1)}%;background:${KIND_COLOUR[kind] ?? '#9aa'}"></span></span>
      <span class="bar-value">${count}</span>
    `;
    breakdown.append(row);
  }

  const issues: { tone: 'ok' | 'warn' | 'error'; text: string }[] = [];
  if (warnings.length === 0) {
    issues.push({ tone: 'ok', text: 'Zero generation warnings — every planned object was placed.' });
  }
  for (const warning of warnings.slice(0, 6)) {
    issues.push({ tone: 'warn', text: warning });
  }
  for (const error of validation.errors.slice(0, 4)) {
    issues.push({ tone: 'error', text: `${error.code}: ${error.message}` });
  }
  for (const warning of validation.warnings.slice(0, 4)) {
    issues.push({ tone: 'warn', text: `${warning.code}: ${warning.message}` });
  }
  notes.innerHTML = '';
  for (const issue of issues) {
    const pill = document.createElement('p');
    pill.className = `note note-${issue.tone}`;
    pill.textContent = issue.text;
    notes.append(pill);
  }

  const json = JSON.stringify(plan, null, 2);
  const lines = json.split('\n');
  jsonOutput.textContent =
    lines.slice(0, 64).join('\n') + (lines.length > 64 ? `\n… ${lines.length - 64} more lines` : '');
  downloadButton.disabled = false;
  mapCaption.textContent = `Seed ${plan.seed} · ${plan.objects.length} objects · ${plan.groups.length} groups · ${
    plan.terrain.style
  } terrain · ${plan.environment.sunElevation}° sun`;
}

function setStatus(text: string, busy = false): void {
  statusLine.textContent = text;
  statusLine.dataset.busy = String(busy);
}

async function generate(): Promise<void> {
  const prompt = promptField.value.trim();
  if (prompt.length < 3) {
    setStatus('Describe a world in a few words first.');
    promptField.focus();
    return;
  }

  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  button?.setAttribute('disabled', 'true');
  setStatus('Interpreting the brief and placing objects…', true);

  try {
    // Yield one frame so the busy state paints before the generator runs.
    await new Promise((resolve) => window.setTimeout(resolve, 16));
    const seed = numberFromInput(seedField, 20261020);
    const started = performance.now();
    const interpretation = interpretPromptLocally(prompt, {
      seed,
      style: styleField.value === 'auto' ? undefined : (styleField.value as WorldStyle),
      scale: scaleField.value === 'auto' ? undefined : (scaleField.value as WorldScale),
      density:
        densityField.value === 'auto' ? undefined : (densityField.value as WorldDensity),
    });
    const report = generateWorldPlanWithReport(interpretation.intent);
    const elapsed = Math.max(1, Math.round(performance.now() - started));
    currentPlan = report.plan;
    renderStats(report);
    drawMap(report.plan, null);
    setStatus(
      `Generated and validated ${report.plan.objects.length} objects in ${elapsed} ms in this tab — no server, no API key.`,
    );

    const params = new URLSearchParams({
      prompt,
      seed: String(report.plan.seed),
    });
    if (styleField.value !== 'auto') params.set('style', styleField.value);
    if (scaleField.value !== 'auto') params.set('scale', scaleField.value);
    if (densityField.value !== 'auto') params.set('density', densityField.value);
    const nextUrl = `${window.location.pathname}#${params.toString()}`;
    window.history.replaceState(null, '', nextUrl);
  } catch (error) {
    console.error(error);
    setStatus(
      `Generation failed: ${error instanceof Error ? error.message : 'unknown error'}. Try a different brief.`,
    );
  } finally {
    button?.removeAttribute('disabled');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void generate();
});

shuffleButton.addEventListener('click', () => {
  seedField.value = String(Math.floor(Math.random() * 4_000_000_000));
  void generate();
});

downloadButton.addEventListener('click', () => {
  if (!currentPlan) return;
  const blob = new Blob([JSON.stringify(currentPlan, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${currentPlan.name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'world'}.world.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ---------------------------------------------------------------- map canvas

function worldToScreen(plan: WorldPlan): (x: number, z: number) => [number, number] {
  const width = canvas.clientWidth || 640;
  const height = canvas.clientHeight || 640;
  const scale = Math.min(width, height) / (plan.terrain.size * 1.04);
  return (x: number, z: number) => [
    width / 2 + x * scale,
    height / 2 + z * scale,
  ];
}

function topDownLength(plan: WorldPlan): number {
  const width = canvas.clientWidth || 640;
  const height = canvas.clientHeight || 640;
  return Math.min(width, height) / (plan.terrain.size * 1.04);
}

/** World-space points of a polyline object (its points are local offsets). */
function worldPolyline(object: WorldObject): [number, number][] {
  if (object.kind !== 'path' && object.kind !== 'river' && object.kind !== 'fence') return [];
  return object.points.map((point) => [
    object.transform.position[0] + point[0],
    object.transform.position[2] + point[2],
  ]);
}

function drawRotatedRect(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  width: number,
  depth: number,
  rotationDeg: number,
  fill: string,
  stroke: string,
  lineWidth: number,
): void {
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate((-rotationDeg * Math.PI) / 180);
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.rect(-width / 2, -depth / 2, width, depth);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawMap(plan: WorldPlan, highlightId: string | null): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = canvas.clientWidth || 640;
  const cssHeight = canvas.clientHeight || 640;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const toScreen = worldToScreen(plan);
  const unit = topDownLength(plan);
  const half = plan.terrain.size / 2;
  hits = [];

  // Ground.
  const background = context.createRadialGradient(
    cssWidth * 0.5,
    cssHeight * 0.42,
    unit * 10,
    cssWidth * 0.5,
    cssHeight * 0.5,
    unit * plan.terrain.size * 0.7,
  );
  background.addColorStop(0, plan.terrain.palette.high);
  background.addColorStop(1, plan.terrain.palette.low);
  context.fillStyle = background;
  context.fillRect(0, 0, cssWidth, cssHeight);

  // 20 m grid.
  context.strokeStyle = 'rgba(20, 32, 18, 0.12)';
  context.lineWidth = 1;
  for (let x = -half; x <= half; x += 20) {
    const [sx, sy] = toScreen(x, -half);
    context.beginPath();
    context.moveTo(sx, sy);
    context.lineTo(sx, sy + plan.terrain.size * unit);
    context.stroke();
  }
  for (let z = -half; z <= half; z += 20) {
    const [sx, sy] = toScreen(-half, z);
    context.beginPath();
    context.moveTo(sx, sy);
    context.lineTo(sx + plan.terrain.size * unit, sy);
    context.stroke();
  }

  const drawOrder: WorldObject['kind'][] = [
    'primitive',
    'field',
    'path',
    'river',
    'bridge',
    'fence',
    'rock',
    'tree',
    'building',
    'lantern',
  ];

  for (const kind of drawOrder) {
    for (const object of plan.objects) {
      if (object.kind !== kind) continue;
      // position is [x, y, z]; the map projects x/z, so world height is unused.
      const [x, , z] = object.transform.position;
      const [sx, sy] = toScreen(x, z);
      const dims = object.meta.dimensions;
      const scale = object.transform.scale;

      if (object.kind === 'field') {
        drawRotatedRect(
          context,
          sx,
          sy,
          object.width * unit,
          object.depth * unit,
          object.transform.rotation[1],
          object.cropColor,
          'rgba(60, 40, 18, 0.45)',
          1.4,
        );
        hits.push({ object, x: sx, y: sy, radius: Math.max(10, (object.width * unit) / 2) });
      } else if (object.kind === 'path') {
        const points = worldPolyline(object).map(([px, pz]) => toScreen(px, pz));
        context.strokeStyle = object.color;
        context.lineWidth = Math.max(2.5, object.width * unit);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.beginPath();
        points.forEach(([px, py], index) => (index === 0 ? context.moveTo(px, py) : context.lineTo(px, py)));
        context.stroke();
        points.forEach(([px, py]) => hits.push({ object, x: px, y: py, radius: 8 }));
      } else if (object.kind === 'river') {
        const points = worldPolyline(object).map(([px, pz]) => toScreen(px, pz));
        context.strokeStyle = object.color;
        context.lineWidth = Math.max(3, object.width * unit);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.beginPath();
        points.forEach(([px, py], index) => (index === 0 ? context.moveTo(px, py) : context.lineTo(px, py)));
        context.stroke();
        context.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        context.lineWidth = Math.max(1, object.width * unit * 0.22);
        context.stroke();
        points.forEach(([px, py]) => hits.push({ object, x: px, y: py, radius: 8 }));
      } else if (object.kind === 'fence') {
        const points = worldPolyline(object).map(([px, pz]) => toScreen(px, pz));
        context.strokeStyle = object.style === 'stone' ? '#8f8878' : object.postColor;
        context.lineWidth = object.style === 'stone' ? 2.6 : 1.8;
        context.setLineDash(object.style === 'stone' ? [] : [4, 3]);
        context.beginPath();
        points.forEach(([px, py], index) => (index === 0 ? context.moveTo(px, py) : context.lineTo(px, py)));
        context.stroke();
        context.setLineDash([]);
        points.forEach(([px, py]) => hits.push({ object, x: px, y: py, radius: 6 }));
      } else if (object.kind === 'bridge') {
        drawRotatedRect(
          context,
          sx,
          sy,
          object.length * unit,
          object.width * unit,
          object.transform.rotation[1],
          object.deckColor,
          'rgba(20, 20, 20, 0.5)',
          1,
        );
        hits.push({ object, x: sx, y: sy, radius: Math.max(8, (object.length * unit) / 2) });
      } else if (object.kind === 'building') {
        drawRotatedRect(
          context,
          sx,
          sy,
          dims[0] * scale[0] * unit,
          dims[2] * scale[2] * unit,
          object.transform.rotation[1],
          object.roofColor,
          'rgba(28, 22, 16, 0.75)',
          1.6,
        );
        hits.push({
          object,
          x: sx,
          y: sy,
          radius: Math.max(10, (Math.max(dims[0], dims[2]) * unit) / 2),
        });
      } else if (object.kind === 'tree') {
        const radius = Math.max(2.2, (dims[0] * scale[0] * unit) / 2);
        context.fillStyle = object.color;
        context.strokeStyle = 'rgba(24, 38, 20, 0.55)';
        context.lineWidth = 1;
        context.beginPath();
        if (object.variant === 'pine') {
          for (let corner = 0; corner < 3; corner += 1) {
            const angle = -Math.PI / 2 + (corner * Math.PI * 2) / 3;
            const px = sx + Math.cos(angle) * radius * 1.35;
            const py = sy + Math.sin(angle) * radius * 1.35;
            if (corner === 0) context.moveTo(px, py);
            else context.lineTo(px, py);
          }
          context.closePath();
        } else {
          context.arc(sx, sy, radius, 0, Math.PI * 2);
        }
        context.fill();
        context.stroke();
        hits.push({ object, x: sx, y: sy, radius: Math.max(6, radius) });
      } else if (object.kind === 'rock') {
        const radius = Math.max(2, (dims[0] * scale[0] * unit) / 2);
        context.fillStyle = object.color;
        context.strokeStyle = 'rgba(30, 30, 28, 0.5)';
        context.beginPath();
        for (let corner = 0; corner < 5; corner += 1) {
          const angle = (corner * Math.PI * 2) / 5 + 0.4;
          const px = sx + Math.cos(angle) * radius;
          const py = sy + Math.sin(angle) * radius;
          if (corner === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        }
        context.closePath();
        context.fill();
        context.stroke();
        hits.push({ object, x: sx, y: sy, radius: Math.max(5, radius) });
      } else if (object.kind === 'lantern') {
        const glow = context.createRadialGradient(sx, sy, 0, sx, sy, 9);
        glow.addColorStop(0, 'rgba(255, 196, 107, 0.9)');
        glow.addColorStop(1, 'rgba(255, 196, 107, 0)');
        context.fillStyle = glow;
        context.beginPath();
        context.arc(sx, sy, 9, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = object.color;
        context.beginPath();
        context.arc(sx, sy, 2.2, 0, Math.PI * 2);
        context.fill();
        hits.push({ object, x: sx, y: sy, radius: 7 });
      } else {
        const radius = Math.max(3, (Math.max(dims[0], dims[2]) * unit) / 2);
        context.fillStyle = object.color;
        context.strokeStyle = 'rgba(0,0,0,0.4)';
        context.beginPath();
        context.rect(sx - radius, sy - radius, radius * 2, radius * 2);
        context.fill();
        context.stroke();
        hits.push({ object, x: sx, y: sy, radius });
      }
    }
  }

  if (highlightId) {
    const target = hits.find((hit) => hit.object.id === highlightId);
    if (target) {
      context.strokeStyle = '#f6d39a';
      context.lineWidth = 2.5;
      context.beginPath();
      context.arc(target.x, target.y, Math.max(9, target.radius + 4), 0, Math.PI * 2);
      context.stroke();
    }
  }

  // Compass + scale bar.
  context.fillStyle = 'rgba(12, 20, 12, 0.55)';
  context.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  context.fillText('N', cssWidth - 22, 22);
  context.beginPath();
  context.moveTo(cssWidth - 18, 30);
  context.lineTo(cssWidth - 18, 46);
  context.strokeStyle = 'rgba(12, 20, 12, 0.55)';
  context.lineWidth = 1.5;
  context.stroke();
  context.fillText('20 m', 14, cssHeight - 12);
  context.fillRect(12, cssHeight - 20, 20 * unit, 3);
}

function findHit(clientX: number, clientY: number): HitTarget | null {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best: HitTarget | null = null;
  let bestDistance = Infinity;
  for (const hit of hits) {
    const distance = Math.hypot(hit.x - x, hit.y - y);
    if (distance > hit.radius) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = hit;
    }
  }
  return best;
}

canvas.addEventListener('pointermove', (event) => {
  if (!currentPlan) return;
  const hit = findHit(event.clientX, event.clientY);
  const rect = canvas.getBoundingClientRect();
  if (!hit) {
    if (hoveredId) {
      hoveredId = null;
      drawMap(currentPlan, null);
    }
    tooltip.hidden = true;
    return;
  }
  if (hit.object.id !== hoveredId) {
    hoveredId = hit.object.id;
    drawMap(currentPlan, hoveredId);
  }
  tooltip.hidden = false;
  tooltip.innerHTML = `<strong>${hit.object.name}</strong><span>${hit.object.kind} · ${
    hit.object.meta.geometry
  }</span>`;
  const left = Math.min(rect.width - 190, Math.max(8, event.clientX - rect.left + 14));
  const top = Math.min(rect.height - 60, Math.max(8, event.clientY - rect.top - 8));
  tooltip.style.transform = `translate(${left}px, ${top}px)`;
});

canvas.addEventListener('pointerleave', () => {
  if (hoveredId && currentPlan) {
    hoveredId = null;
    drawMap(currentPlan, null);
  }
  tooltip.hidden = true;
});

window.addEventListener('resize', () => {
  if (currentPlan) drawMap(currentPlan, hoveredId);
});

// -------------------------------------------------------------------- legend

function buildLegend(): void {
  legend.innerHTML = '';
  for (const kind of [
    'building',
    'field',
    'path',
    'river',
    'fence',
    'tree',
    'rock',
    'lantern',
  ] as const) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<i style="background:${KIND_COLOUR[kind]}" aria-hidden="true"></i>${
      KIND_LABEL[kind] ?? kind
    }`;
    legend.append(item);
  }
}

// ------------------------------------------------------------------- startup

buildLegend();

const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const initialPrompt = params.get('prompt');
if (initialPrompt) promptField.value = initialPrompt;
if (params.get('seed')) seedField.value = params.get('seed') ?? '';
if (params.get('style')) styleField.value = params.get('style') ?? 'auto';
if (params.get('scale')) scaleField.value = params.get('scale') ?? 'auto';
if (params.get('density')) densityField.value = params.get('density') ?? 'auto';

// First render happens once fonts/layout settle so the canvas fills its box.
if (prefersReducedMotion) {
  void generate();
} else {
  requestAnimationFrame(() => {
    mapFigure.classList.add('is-ready');
    void generate();
  });
}
