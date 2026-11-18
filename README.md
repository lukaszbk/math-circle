# Math Kangaroo Circle

A tablet-first web app, Google Sheet bridge, and weekly PDF pack compiler for a 3rd-grade after-school Math Kangaroo circle.

## Quickstart (Local Class Server)

Start the local web app + Sheet-compatible JSON API server:

```bash
python3 serve.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in any browser or tablet on your local network (`--host 0.0.0.0`).

- **Pre-seeded Student PINs (local server & demo mode):**
  - Ada Guzhu (`2418`), Andrew Ahmadi (`5931`), Berrit Martz (`7264`), Camile Gauthier (`3847`), Elliot An (`6159`), Elliot Huang (`8492`), Hanna Bieniasz-Krzywiec (`4726`), Keshav Junnarkar (`9315`), Ting Zhao (`1683`)
- **Teacher Zone PIN:** `885174`

## Compiling a Weekly Question Pack from PDF

Requires `pdftoppm` (Poppler) and `convert` / `identify` (ImageMagick):

```bash
python3 pack-compiler/compile_pack.py \
  --pdf pack-compiler/input/2022-g34.pdf \
  --part 1 \
  --metadata pack-compiler/packs/2022-g34-part1.meta.json \
  --out-dir webapp/packs/2022-g34-part1
```

- Supports `--part 1` (`1–4, 9–12, 17–20`), `--part 2` (`5–8, 13–16, 21–24`), or `--questions 1,2,...`.
- Outputs 12 cropped PNG diagrams (`q01.png`…), `pack.json`, `webapp/packs/index.json`, and a visual verification sheet at `preview.html`.

## Connecting Google Sheets in 60 Seconds

See [`sheet-backend/SETUP.md`](sheet-backend/SETUP.md):

1. Open the **Math Circle 2026/2027** Google Sheet (`1uWyyPhBvUgaU1odlJQ20d9X6Io5icrF4EQMkDwDC-kE`).
2. Go to **Extensions → Apps Script** and paste [`sheet-backend/Code.gs`](sheet-backend/Code.gs).
3. Click **Deploy → New deployment → Web app** (`Execute as: Me`, `Who has access: Anyone`) and copy the `/exec` URL.
4. Paste the `/exec` URL into `appsScriptUrl` in [`webapp/config.js`](webapp/config.js) or inside **Teacher Zone → Roster, PINs & Sheet Link**.

## Running Tests

```bash
python3 -m unittest discover -s tests -v
```
