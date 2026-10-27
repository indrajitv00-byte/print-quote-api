# print-quote-api

Upload an STL with slicing settings, get weight, print time, size and volume back as JSON.
API only, no website, no pricing.

## Run

```bash
docker compose up --build -d
```

The first build downloads OrcaSlicer (about 150 MB), so it takes a few minutes.
The API is then at http://localhost:3000

## Postman

1. Method **POST**, URL `http://localhost:3000/api/quote`
2. Body > **form-data**
3. Key `model`, change its type from Text to **File**, choose your `.stl`
4. Optional: add more rows (type Text) for slicing settings, e.g. `infill` = `30`
5. Send

## curl

```bash
curl -F model=@part.stl http://localhost:3000/api/quote
curl -F model=@part.stl -F infill=30 -F supports=true http://localhost:3000/api/quote
curl -F model=@part.stl "http://localhost:3000/api/quote?download=1" -o result.json
```

PowerShell (Windows): use `curl.exe -F "model=@part.stl" http://localhost:3000/api/quote`

## Slicing settings (form fields, all optional except `model`)

| field | values | default |
|---|---|---|
| model | the .stl file, exactly one (max 50 MB) | required |
| material | PLA, PETG, ABS (more types when `printer` is set, see below) | PLA |
| printer | an OrcaSlicer printer name, e.g. `Bambu Lab A1 0.4 nozzle` | your own printer (template) |
| process | an OrcaSlicer process preset for that printer | the printer's default |
| filament | an OrcaSlicer filament preset for that printer | best "Generic" one for `material` |
| quality | standard (0.2 mm), medium (0.15 mm), high (0.1 mm) | standard |
| infill | 10,15,20,30,40,50,60,70,80,90 | 15 |
| rotX, rotY, rotZ | 0, 90, 180, 270 (degrees) | 0 |
| strength | light (2 walls), standard (3), strong (5) | standard |
| supports | true / false | false |
| scale | 0.01 - 100 | 1 |
| gcode | true / false: also return the G-code (exact slices only) | false |
| mode | `auto`, `exact` (OrcaSlicer), `estimate` (instant, approximate) | `auto` = exact when the slicer is installed |

Material: each material has its own OrcaSlicer template in `templates/` (`PLA_standard.3mf`,
`PETG_standard.3mf`, `ABS_standard.3mf`), so weight and time come from a real slice with that
material's filament profile. To change a material's settings, edit its template in OrcaSlicer
(keep the model inside named `test.stl`) and save it over the file, then rebuild.

## All of OrcaSlicer's printers and materials

Without `printer`, the API uses your own printer, which is set up in the three templates.
With `printer`, it uses OrcaSlicer's built-in profiles, so the result is what OrcaSlicer would give
for that printer (bed size, speeds, acceleration, filament profile...).

1. Find a printer: `GET /api/printers?q=ender` (also `?vendor=Creality`).
   About 830 single-nozzle printers are listed; send the `name` exactly as shown.
2. See what it supports: `GET /api/options?printer=Creality Ender-3 V4 0.4 nozzle`
   returns its default process, the processes, the materials (PLA, PETG, ABS, TPU, ASA, PA, PC...) and the filament presets.
3. Slice: send `printer`, and optionally `material`, `filament`, `process`.

```bash
curl -F model=@part.stl -F "printer=Bambu Lab A1 0.4 nozzle" -F material=PETG http://localhost:3000/api/quote
```

The response then also has `"used": { "printer", "process", "filament" }`, the presets that were really used.

Notes:
- `material` picks the generic filament of that type for the printer; send `filament` to choose an exact preset.
- With a printer chosen, `quality`, `infill`, `strength` and `supports` are used only if you send them.
  If you leave them out, the printer's own process values apply (for example Bambu printers use 2 walls,
  so their weight and time match OrcaSlicer's own numbers for that printer). The defaults in the table
  above (15% infill, standard strength, 0.2 mm) are for your own templates, when `printer` is not sent.
  If you send `process` but not `quality`, the process keeps its own layer height.
- A model larger than the printer's bed returns HTTP 422 with a message.
- The printer's own profile is merged into a project file; settings Orca's profile does not define
  fall back to the template's values (Orca defaults).

## Response

```json
{
  "stats": {
    "weightG": 4,
    "seconds": 594,
    "sizeMm": [20, 20, 20],
    "volumeCm3": 8,
    "watertight": true
  }
}
```

With `gcode=true` the response also has a `"gcode"` field: the complete G-code as one text string
(can be several MB for big models).

Errors return `{ "error": "..." }` with HTTP 400, 401, 413, 422, 500 or 503.
`GET /health` returns `{"ok":true,"slicer":true}`.

## Security

Set `API_KEY` in docker-compose.yml to require header `x-api-key` on every call except `/health`.

## Without Docker (estimate mode only)

```bash
npm install
npm start
```