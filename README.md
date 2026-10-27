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
| material | PLA, PETG, ABS | PLA |
| quality | standard (0.2 mm), medium (0.15 mm), high (0.1 mm) | standard |
| infill | 10,15,20,30,40,50,60,70,80,90 | 15 |
| rotX, rotY, rotZ | 0, 90, 180, 270 (degrees) | 0 |
| strength | light (2 walls), standard (3), strong (5) | standard |
| supports | true / false | false |
| scale | 0.01 - 100 | 1 |
| mode | `auto`, `exact` (OrcaSlicer), `estimate` (instant, approximate) | `auto` = exact when the slicer is installed |

Material note: every material is sliced with the PLA template, and the weight is corrected by the
material's density (PLA 1.24, PETG 1.27, ABS 1.04 g/cm3). Print time is the PLA time. For exact
PETG/ABS times, add a template made from a PETG/ABS profile in OrcaSlicer.

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

Errors return `{ "error": "..." }` with HTTP 400, 401, 413, 500 or 503.
`GET /health` returns `{"ok":true,"slicer":true}`.

## Security

Set `API_KEY` in docker-compose.yml to require header `x-api-key` on every call except `/health`.

## Without Docker (estimate mode only)

```bash
npm install
npm start
```