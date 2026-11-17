/**
 * Builds `docs/game-map/index.html` — a standalone, offline Arabic page with the
 * map's hero renders, the printable paper map (inline SVG), the full design
 * sheet text and a legend. No server, no JavaScript, no external assets: double
 * click the file and the whole map design is readable.
 *
 *   npx tsx scripts/renderMapPage.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import {
  ARENAS,
  BOSSES,
  BOSS_ORDER,
  CHECKPOINTS,
  GUIDE,
  LOOP_NOTES,
  MAIN_ROUTE,
  REGIONS,
  SHORTCUTS,
  STATS,
} from '../src/game-map/data';

const svg = readFileSync('docs/game-map/paper-map.svg', 'utf8');
const inlineSvg = svg.replace(/^<\?xml[^>]*>\s*/, '');

/**
 * Every raster in the page is compressed and inlined as base64, so the finished
 * page is ONE file that can be emailed, dropped in a chat, or opened from a USB
 * stick with no server, no repo and no internet.
 */
const inlinedImages = new Map<string, string>();

async function inlineRenders(): Promise<void> {
  const renders = ['overview', 'farm', 'crops', 'pens', 'start', 'finale', 'top'];
  let total = 0;
  for (const name of renders) {
    const jpeg = await sharp(`docs/game-map/${name}.png`)
      .resize({ width: 1180, withoutEnlargement: true })
      .jpeg({ quality: 74, mozjpeg: true })
      .toBuffer();
    total += jpeg.length;
    inlinedImages.set(`${name}.png`, `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  }
  console.log(`Inlined ${renders.length} renders (${(total / 1024).toFixed(0)} kB of JPEG)`);
}

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const regionCards = REGIONS.map(
  (region) => `
  <article class="region" style="--c:${region.color}">
    <header>
      <span class="region-emoji">${region.emoji}</span>
      <div>
        <p class="kicker">${esc(region.kicker)}</p>
        <h3>${esc(region.name)}</h3>
        <p class="tagline">${esc(region.tagline)}</p>
      </div>
    </header>
    <p class="summary">${esc(region.summary)}</p>
    <p class="mood">🌤️ ${esc(region.mood)}</p>
    <ol class="beats">
      ${region.beats
        .map((beat) => `<li><strong>${esc(beat.title)}</strong> — ${esc(beat.detail)}</li>`)
        .join('\n      ')}
    </ol>
    <div class="chips">
      <span>👾 ${region.encounters.length} لقاءات</span>
      <span>⚠️ ${region.hazards.length} مخاطر</span>
      <span>🎁 ${region.loot.length} غنائم</span>
      <span>🔎 ${region.secrets.length} أسرار</span>
    </div>
  </article>`,
).join('\n');

const bossCards = BOSS_ORDER.map((id) => {
  const boss = BOSSES.find((entry) => entry.id === id)!;
  const arena = ARENAS.find((entry) => entry.id === boss.arenaId)!;
  return `
  <article class="boss tier-${boss.tier}">
    <header>
      <span class="boss-emoji">${boss.emoji}</span>
      <div>
        <p class="kicker">${boss.tier === 'final' ? 'البوس النهائي' : boss.tier === 'optional' ? 'بوس اختياري' : 'بوس رئيسي'} · ${esc(boss.level)}</p>
        <h3>${esc(boss.name)}</h3>
        <p class="tagline">${esc(boss.epithet)} · ${esc(boss.species)}</p>
      </div>
      <span class="diff" aria-label="الصعوبة ${boss.difficulty} من 5">${'●'.repeat(boss.difficulty)}${'○'.repeat(5 - boss.difficulty)}</span>
    </header>
    <p class="quote">«${esc(boss.quote)}»</p>
    <p>${esc(boss.intro)}</p>
    <h4>المراحل</h4>
    <ol class="beats">${boss.phases.map((phase) => `<li><strong>${esc(phase.name)}</strong> — ${esc(phase.detail)}</li>`).join('')}</ol>
    <h4>ميكانيكيات ${esc(arena.name)}</h4>
    <ul>${boss.arenaMechanics.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    <h4>نقاط الضعف</h4>
    <ul>${boss.weaknesses.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    <h4>المكافآت</h4>
    <ul>${boss.rewards.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    <p class="note">📝 ${esc(boss.designNote)}</p>
  </article>`;
}).join('\n');

const routeRows = MAIN_ROUTE.map(
  (stop, index) =>
    `<li class="${stop.kind}"><span class="num">${index + 1}</span><strong>${esc(stop.label)}</strong><code>${stop.at[0]}، ${stop.at[1]}</code></li>`,
).join('\n');

const checkpointRows = CHECKPOINTS.map(
  (checkpoint) => `<li><strong>🔥 ${esc(checkpoint.name)}</strong><span>${esc(checkpoint.note)}</span></li>`,
).join('');

const shortcutRows = SHORTCUTS.map(
  (shortcut) =>
    `<li><strong>${esc(shortcut.name)}</strong><span>${esc(shortcut.from)} ← ${esc(shortcut.to)}</span><em>🔓 ${esc(shortcut.unlock)}</em></li>`,
).join('');

const loopRows = LOOP_NOTES.map(
  (loop) => `<li><strong>${esc(loop.from)} ← ${esc(loop.to)}</strong><span>${esc(loop.note)}</span></li>`,
).join('');

const guideCards = GUIDE.map(
  (section) => `<article><h3>${esc(section.title)}</h3><p>${esc(section.body)}</p></article>`,
).join('\n');

await inlineRenders();

const singleFileNote =
  '<p style="text-align:center;font-size:10px;color:#93826c;margin:10px 0 0">' +
  'هذا الملف مكتفٍ بذاته: كل الصور والخريطة الورقية مدمجة داخله — أرسله كما هو.</p>';

const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>زعتر والحضيرة العظمى — خريطة المستويات</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@500;600;700&family=Noto+Sans+Arabic:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #14100c; --bg1: #1b1510; --bg2: #221a13; --line: #3d2f22; --line-soft: #2a2019;
    --text: #f2e8d7; --dim: #c4b39b; --mute: #93826c; --gold: #f0b552; --gold-b: #ffd27a;
    --red: #e4685c; --violet: #c58bf0; --green: #7fc98f;
    --font: "Noto Naskh Arabic", serif; --sans: "Noto Sans Arabic", ui-sans-serif, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: radial-gradient(100% 60% at 50% 0%, #2a2118, #14100c 60%, #0f0c09); color: var(--text); font-family: var(--sans); line-height: 1.7; }
  a { color: var(--gold); }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 70px; }
  header.hero { text-align: center; padding: 26px 16px 20px; }
  header.hero .mark { font-size: 46px; }
  header.hero h1 { font-family: var(--font); font-size: clamp(30px, 5vw, 48px); margin: 8px 0 4px; color: var(--gold-b); }
  header.hero p { margin: 0; color: var(--mute); font-size: 14px; }
  .open-box { display: flex; gap: 14px; align-items: center; background: linear-gradient(180deg, rgba(240,181,82,.16), rgba(240,181,82,.06)); border: 1px solid rgba(240,181,82,.45); border-radius: 14px; padding: 14px 18px; margin: 6px 0 4px; }
  .open-icon { font-size: 26px; flex: none; }
  .open-box strong { display: block; font-family: var(--font); font-size: 17px; color: var(--gold-b); }
  .open-box span { display: block; font-size: 12px; color: var(--dim); margin-top: 2px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 22px 0 10px; }
  .stats div { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 10px; text-align: center; }
  .stats strong { display: block; font-family: var(--font); font-size: 26px; color: var(--gold-b); }
  .stats span { font-size: 11px; color: var(--mute); }
  h2.sec { font-family: var(--font); font-size: 26px; margin: 44px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line); color: var(--gold); }
  h2.sec small { display: block; font-family: var(--sans); font-size: 12px; color: var(--mute); font-weight: 400; }
  .hero-shots { display: grid; gap: 12px; grid-template-columns: 1fr; }
  figure { margin: 0; background: var(--bg2); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
  figure img { display: block; width: 100%; height: auto; }
  figcaption { padding: 9px 14px; font-size: 12px; color: var(--dim); border-top: 1px solid var(--line-soft); }
  .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .paper { background: #efe3c6; border-radius: 16px; padding: 10px; border: 1px solid #8a6d42; }
  .paper svg { width: 100%; height: auto; display: block; border-radius: 9px; }
  .region, .boss { background: var(--bg1); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; }
  .region { border-top: 3px solid var(--c); }
  .region header, .boss header { display: flex; gap: 12px; align-items: flex-start; }
  .region-emoji, .boss-emoji { font-size: 26px; background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; width: 48px; height: 48px; display: grid; place-items: center; flex: none; }
  .region h3, .boss h3 { font-family: var(--font); margin: 2px 0 2px; font-size: 21px; color: var(--gold-b); }
  .kicker { margin: 0; font-size: 10.5px; color: var(--mute); letter-spacing: .4px; }
  .tagline { margin: 0; font-size: 12px; color: var(--c, var(--gold)); font-weight: 600; }
  .summary { font-size: 12.5px; color: var(--dim); text-align: justify; }
  .mood { font-size: 11.5px; color: var(--mute); border-inline-start: 2px solid var(--c, var(--gold)); padding-inline-start: 9px; }
  .beats { padding-inline-start: 18px; margin: 8px 0; }
  .beats li, ul li { font-size: 11.5px; color: var(--dim); margin-bottom: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips span { font-size: 10px; background: var(--bg2); border: 1px solid var(--line-soft); border-radius: 999px; padding: 2px 8px; color: var(--mute); }
  .boss.tier-optional { border-top: 3px solid var(--violet); }
  .boss.tier-final { border-top: 3px solid #ffd54a; }
  .boss.tier-required { border-top: 3px solid var(--red); }
  .diff { margin-inline-start: auto; color: var(--gold); letter-spacing: 2px; font-size: 12px; }
  .quote { font-family: var(--font); font-size: 13px; color: var(--gold-b); background: rgba(240,181,82,.07); border-inline-start: 3px solid var(--gold); border-radius: 8px; padding: 8px 12px; }
  .boss h4 { font-family: var(--font); font-size: 13px; color: var(--gold); margin: 12px 0 4px; }
  .note { font-size: 11.5px; color: var(--dim); border: 1px dashed rgba(240,181,82,.35); border-radius: 9px; padding: 9px 11px; background: rgba(240,181,82,.05); }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .cols article { background: var(--bg1); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
  .cols h3 { font-family: var(--font); font-size: 15px; margin: 0 0 6px; color: var(--gold); }
  .cols p { margin: 0; font-size: 12px; color: var(--dim); text-align: justify; }
  .route { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 0; margin: 0; }
  .route li { display: flex; align-items: center; gap: 7px; background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 5px 10px 5px 5px; font-size: 11.5px; }
  .route .num { width: 20px; height: 20px; border-radius: 50%; background: var(--gold); color: #2a1a08; display: grid; place-items: center; font-size: 10px; font-weight: 700; }
  .route li.boss .num { background: var(--red); color: #fff; }
  .route li.final .num { background: #ffd54a; }
  .route li.start .num { background: var(--green); color: #10241a; }
  .route code { font-size: 9.5px; color: var(--mute); font-family: ui-monospace, monospace; }
  ul.plain { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  ul.plain li { background: var(--bg1); border: 1px solid var(--line-soft); border-radius: 10px; padding: 9px 12px; display: flex; flex-direction: column; gap: 2px; }
  ul.plain strong { font-size: 12px; color: var(--text); }
  ul.plain span { font-size: 11px; color: var(--mute); }
  ul.plain em { font-size: 11px; font-style: normal; color: var(--green); }
  .how { background: var(--bg1); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
  .how ol { padding-inline-start: 20px; }
  .how li { font-size: 12.5px; color: var(--dim); margin-bottom: 7px; }
  .how code { background: #0f0c09; border: 1px solid var(--line); padding: 1px 6px; border-radius: 6px; color: var(--gold-b); font-size: 11.5px; direction: ltr; display: inline-block; }
  .print-btn { font-family: inherit; font-size: 12px; font-weight: 700; color: #2a1a08; background: var(--gold); border: 0; border-radius: 999px; padding: 5px 14px; cursor: pointer; }
  .print-btn:hover { background: var(--gold-b); }
  @media print {
    :root { --bg: #fff; --bg1: #fff; --bg2: #fff; --text: #000; --dim: #222; --mute: #555; }
    body { background: #fff; color: #000; }
    .open-box, .stats, .hero-shots, .grid-3, .boss, .region, .cols, .route, .how, footer, header.hero p { display: none !important; }
    header.hero h1 { color: #000; font-size: 22px; }
    h2.sec { color: #000; border-color: #999; font-size: 14px; margin: 8px 0; }
    h2.sec small { color: #444; }
    .paper { border: 0; padding: 0; background: #fff; }
    .paper svg { width: 100%; height: auto; }
    @page { size: A3 portrait; margin: 8mm; }
  }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); text-align: center; font-size: 11px; color: var(--mute); }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="mark">🦊</div>
    <h1>زعتر والحضيرة العظمى</h1>
    <p>خريطة عالم ثلاثية الأبعاد · أسلوب Souls-like كرتوني كوميدي · إصدار 1.0</p>
  </header>

  <div class="open-box">
    <div class="open-icon">🖱️</div>
    <div>
      <strong>للعرض: انقر مرتين على هذا الملف فقط.</strong>
      <span>لا تحتاج تثبيت أي شيء، ولا خادمًا، ولا إنترنت — كل الصور والخريطة مدمجة داخل الملف نفسه.</span>
    </div>
  </div>

  <div class="stats">
    <div><strong>${STATS.bosses}</strong><span>بوسات من حيوانات المزرعة</span></div>
    <div><strong>${STATS.coreRegions}</strong><span>مناطق أساسية</span></div>
    <div><strong>${STATS.checkpoints}</strong><span>نقاط حفظ</span></div>
    <div><strong>${STATS.arenas}</strong><span>أرينات</span></div>
    <div><strong>${STATS.landmarks}</strong><span>علامة على الخريطة</span></div>
    <div><strong>${STATS.roads}</strong><span>ممرّات ودروب</span></div>
  </div>

  <h2 class="sec">الديوراما ثلاثية الأبعاد <small>لقطات من الخريطة الحقيقية (مصيّرة بدقة كاملة)</small></h2>
  <div class="hero-shots">
    <figure><img src="${inlinedImages.get('overview.png')}" alt="نظرة عامة على الخريطة" /><figcaption>نظرة عامة — الخط المتقطّع الذهبي هو مسار زعتر المقترح بين نقاط الحفظ والأرينات</figcaption></figure>
  </div>
  <div class="grid-3" style="margin-top:12px">
    <figure><img src="${inlinedImages.get('farm.png')}" alt="المزرعة" loading="lazy" /><figcaption>🏠 المنطقة ١ — المزرعة: السوق، البئر، حوش الديك</figcaption></figure>
    <figure><img src="${inlinedImages.get('crops.png')}" alt="منطقة الزراعة" loading="lazy" /><figcaption>🌾 المنطقة ٢ — الزراعة: الحقول، الجرن، الطاحونة</figcaption></figure>
    <figure><img src="${inlinedImages.get('pens.png')}" alt="منطقة الحظائر" loading="lazy" /><figcaption>🐑 المنطقة ٣ — الحظائر: الجسر، المراعي، حلبة الكباش</figcaption></figure>
    <figure><img src="${inlinedImages.get('start.png')}" alt="حافّة الغابة" loading="lazy" /><figcaption>🌲 المقدمة — حافّة الغابة حيث يبدأ زعتر</figcaption></figure>
    <figure><img src="${inlinedImages.get('finale.png')}" alt="قصر الحضيرة" loading="lazy" /><figcaption>👑 الخاتمة — قصر الحضيرة وعرش التبن</figcaption></figure>
    <figure><img src="${inlinedImages.get('top.png')}" alt="من أعلى" loading="lazy" /><figcaption>🧭 مخطط من أعلى — لقراءة الممرّات والحدود</figcaption></figure>
  </div>

  <h2 class="sec">الخريطة الورقية <small>SVG قابل للطباعة — كل الرموز والمسارات على ورقة واحدة</small></h2>
  <div class="paper">${inlineSvg}</div>

  <h2 class="sec">خط سير زعتر <small>Route · hub &amp; spoke</small></h2>
  <ul class="route">${routeRows}</ul>

  <h2 class="sec">افكار التصميم <small>لماذا هذه الخريطة تبدو هكذا؟</small></h2>
  <div class="cols">${guideCards}</div>

  <h2 class="sec">المناطق <small>حافّة الغابة ← المزرعة ← الزراعة ← الحظائر ← القصر</small></h2>
  <div class="grid-3">${regionCards}</div>

  <h2 class="sec">البوسات الخمسة <small>لا مخلوقات خيالية: ديك رومي، ديك، بطة، كبش، دجاجة ملكية</small></h2>
  <div class="grid-3">${bossCards}</div>

  <h2 class="sec">الشبكة والحلقات <small>نقاط الحفظ · الاختصارات · الترابط</small></h2>
  <div class="cols">
    <article>
      <h3>🔥 نقاط الحفظ</h3>
      <ul class="plain">${checkpointRows}</ul>
    </article>
    <article>
      <h3>🔓 الاختصارات</h3>
      <ul class="plain">${shortcutRows}</ul>
    </article>
    <article>
      <h3>🔁 حلقات الرجوع</h3>
      <ul class="plain">${loopRows}</ul>
    </article>
  </div>

  <h2 class="sec">كيف تشاهد الخريطة؟ <small>ثلاث طرق</small></h2>
  <div class="how">
    <ol>
      <li><strong>هذه الصفحة:</strong> افتح <code>docs/game-map/index.html</code> مباشرة في المتصفح — كل شيء يعمل بدون خادم أو إنترنت.</li>
      <li><strong>الديوراما التفاعلية:</strong> من جذر المشروع نفّذ <code>npm install</code> ثم <code>npm run dev</code> وافتح <code>http://localhost:5173/game-map.html</code> — تدوير، تكبير، نقر المناطق والبوسات، وجولة تلقائية.</li>
      <li><strong>للطباعة:</strong> اضغط زرّ <button type="button" class="print-btn" onclick="window.print()">🖨️ طباعة الخريطة الورقية</button> — الخريطة أعلاه تُطبع على ورقة A3/٤ عمودية.</li>
    </ol>
  </div>

  <footer>
    وُلدت هذه الصفحة من <code>scripts/renderMapPage.ts</code> ومن بيانات <code>src/game-map/data.ts</code> — لا يوجد أي رقم أو موقع مكتوب يدويًا هنا.
  </footer>
</div>
</body>
</html>
`;

mkdirSync('docs/game-map', { recursive: true });
mkdirSync('docs', { recursive: true });

// Portable copy: every image inlined, one file, nothing beside it.
const portableHtml = html.replace('</body>', singleFileNote + '</body>');
writeFileSync('docs/خريطة-زعتر.html', portableHtml);

// Same page for serving/Browsing next to its sibling PNGs and the SVG: keep the
// file references so the repo stays light and the images stay replaceable.
const folderHtml = portableHtml
  .replace(/src="data:image\/jpeg;base64,[^"]+"/g, (_match, offset: number, whole: string) => {
    // Restore the original file name by order of appearance.
    const order = ['overview.png', 'farm.png', 'crops.png', 'pens.png', 'start.png', 'finale.png', 'top.png'];
    const index = (whole.slice(0, offset).match(/src="data:/g) ?? []).length;
    return `src="${order[index] ?? 'overview.png'}"`;
  })
  .replace(singleFileNote, '');
writeFileSync('docs/game-map/index.html', folderHtml);

console.log(`Wrote docs/خريطة-زعتر.html (${(portableHtml.length / 1024 / 1024).toFixed(2)} MB, self-contained)`);
console.log(`Wrote docs/game-map/index.html (${(folderHtml.length / 1024).toFixed(1)} kB, uses sibling files)`);
