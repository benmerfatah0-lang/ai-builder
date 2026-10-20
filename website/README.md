# Project site

The marketing site for AI World Builder: a static page plus a live playground that
runs the real prompt interpreter and world generator in the browser.

```
website/
  public/            everything served to visitors
    index.html       landing page
    styles.css       site styles (no framework, no web fonts)
    site.js          sticky header, mobile nav, reveals, gallery lightbox
    demo.js          generated: the playground bundle (git-ignored)
    app/             generated: the editor build served at /app/ (git-ignored)
    img/             farm renders and real editor screenshots
  src/demo.ts        playground source — imports from ../src
  server.mjs         zero-dependency static server
```

## Run it

```bash
npm run site:build   # compile demo.js + build the editor into public/app
npm run site         # http://localhost:4173  (site) and /app/ (editor)
```

`npm run site` alone works when `public/demo.js` and `public/app/` already exist.
`npm run site:demo` (or `site:demo:watch`) rebuilds just the playground.

## Notes

- The playground imports the **real** modules (`modules/ai/promptInterpreter`,
  `core/generation/generateWorld`), so the page cannot describe behaviour the app
  does not have. It is bundled by esbuild — no runtime framework on the site.
- Farm renders in `public/img/` come from `npm run render:preview`
  (`scripts/renderPreview.ts`), a software rasteriser that walks the real scene
  graph. Editor screenshots in `public/img/app/` are real WebGL 2 captures.
- The server binds `0.0.0.0` and permits any Host header, so it works behind the
  preview proxy and on a phone over the local network.
