# Math Kangaroo Circle

A tablet-first web app, Google Sheet bridge, and weekly PDF pack compiler for a 3rd-grade after-school Math Kangaroo circle.

## Hosting on GitHub Pages (100% Static — No Server Needed)

The web app in `webapp/` is 100% static HTML, ES modules, CSS, JSON, and PNGs (`serve.py` is only for local offline testing). In production on GitHub Pages, browsers talk directly to your Google Sheet via the bound Apps Script Web App (`sheet-backend/Code.gs`).

Both GitHub Pages modes are supported out of the box at `https://<your-username>.github.io/math-circle/`:
1. **Branch mode (simplest):** In GitHub **Settings → Pages → Build and deployment**, set **Source** to **Deploy from a branch**, choose **`main`** and **`/ (root)`**, and click **Save** (root `index.html` + `.nojekyll` load `webapp/` directly).
2. **GitHub Actions mode:** Set **Source** to **GitHub Actions** (`.github/workflows/pages.yml` deploys `./webapp` automatically on every push to `main`).

To connect all tablets on GitHub Pages to your Google Sheet permanently, paste your Apps Script `/exec` URL into `appsScriptUrl` in [`webapp/config.js`](webapp/config.js) and push to `main`.

## Quickstart (Local Class Server)

Start the local web app + Sheet-compatible JSON API server:

```bash
python3 serve.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in any browser or tablet on your local network (`--host 0.0.0.0`).

- **Student Roster & PINs:** Real student names and PINs live only in the connected Google Sheet (never in static `webapp/`). For local offline testing, `serve.py` seeds sample fictional students (viewable and editable in **Teacher Zone** or `serve.py`).
- **Teacher Zone PIN:** `885174`

## Compiling a Weekly Question Pack from PDF

Use the [`compile-weekly-pack`](.agents/skills/compile-weekly-pack/SKILL.md) workflow or run `pack-compiler/compile_pack.py` directly (requires `pdftoppm` and `convert`/`identify`):

```bash
# Stage 1: render 300-DPI pages, ruled reference grids, and draft crops
python3 pack-compiler/compile_pack.py \
  --pdf pack-compiler/input/2022-g34.pdf \
  --part 1 \
  --week-id 2022-g34-part1 \
  --crop-only

# Stage 5: compile final pack with verified answers & teaching guides
python3 pack-compiler/compile_pack.py \
  --pdf pack-compiler/input/2022-g34.pdf \
  --part 1 \
  --metadata pack-compiler/packs/2022-g34-part1.meta.json \
  --out-dir webapp/packs/2022-g34-part1
```

- Supports `--part 1` (`1–4, 9–12, 17–20`), `--part 2` (`5–8, 13–16, 21–24`), or `--questions 1,2,...`, plus per-question `customBox` / `maskRects` overrides for arbitrary PDF layouts.
- Outputs 12 cropped PNG diagrams (`q01.png`…), `pack.json`, `webapp/packs/index.json`, and a visual verification sheet at `preview.html`.

## Connecting Google Sheets in 60 Seconds

See [`sheet-backend/SETUP.md`](sheet-backend/SETUP.md):

1. Open the **Math Circle 2026/2027** Google Sheet (`1uWyyPhBvUgaU1odlJQ20d9X6Io5icrF4EQMkDwDC-kE`).
2. Go to **Extensions → Apps Script** and paste [`sheet-backend/Code.gs`](sheet-backend/Code.gs).
   - Includes `onEdit` and the **🦘 Math Circle → Sync Participants to Students** menu (`onOpen`) to sync `Participants!A1:A` into `Students` automatically.
3. Click **Deploy → New deployment → Web app** (`Execute as: Me`, `Who has access: Anyone`) and copy the `/exec` URL.
4. Paste the `/exec` URL into `appsScriptUrl` in [`webapp/config.js`](webapp/config.js) or inside **Teacher Zone → Roster, PINs & Sheet Link**.

## Running Tests

```bash
python3 -m unittest discover -s tests -v
```
