# Architecture

## What I built with, and why

**Frontend: vanilla HTML/CSS/JS + Canvas 2D, no framework.** The core interaction
is "draw a few hundred points on a 1024×1024 image and let the user scrub
time," which Canvas handles natively at 60fps without a virtual DOM in the
way. A framework (React/Vue) would add a build step for zero real benefit
here — there's no complex component tree, just one canvas and some filter
controls. This also means the tool is a handful of static files: it deploys
anywhere (Vercel, Netlify, GitHub Pages, a plain S3 bucket) with no build
step and no server.

**Data pipeline: pure Python, zero third-party dependencies.** The obvious
choice for reading Parquet is `pyarrow`. The build environment I used to
produce this submission didn't have it available and had no network access
to install it, so `scripts/thrift_compact.py` + `scripts/mini_parquet.py`
implement just enough of the Parquet spec to read this specific dataset:
a generic Thrift compact-protocol decoder, a raw Snappy block decompressor,
and PLAIN/dictionary decoding for the physical types actually present
(BYTE_ARRAY, FLOAT, INT64). It's ~250 lines total and validated byte-for-byte
against the sample row in the provided README. In a normal environment I'd
reach for `pyarrow` or `duckdb` and skip writing this — I'm keeping it here
because it works, has zero dependencies (nothing to install to reproduce the
build), and doubles as documentation of exactly what's in these files. If
you have `pyarrow` available, swapping `scripts/mini_parquet.py`'s
`read_parquet_rows()` for `pq.read_table(path).to_pandas()` is a drop-in
replacement.

## Data flow

```
player_data/{day}/*.nakama-0   (1,243 parquet files, one per player-in-match)
        │
        │  scripts/mini_parquet.py   (parse each file: user_id, match_id,
        │                             map_id, x, y, z, ts, event)
        ▼
scripts/build_dataset.py
        │  - groups rows by match_id
        │  - classifies each user_id as human (UUID) or bot (numeric)
        │  - de-dupes a handful of files that appear twice (see Assumptions)
        ▼
raw_matches.json   (intermediate, ~3.5 MB, one entry per match)
        │
        │  scripts/compact_export.py
        │  - drops elevation (y) — not used for 2D plotting per the README
        │  - converts each match's timestamps to match-relative seconds
        │  - rounds coordinates to 0.01 units, event names to small int codes
        │  - sorts matches by date/start time
        ▼
data/dataset.json   (~2.0 MB, all 796 matches, loaded once by the browser)
        │
        ▼
app.js  — fetches dataset.json + the 3 minimap images on load, then
          everything else (filtering, drawing, playback, heatmap binning)
          happens client-side. No backend, no API calls after the initial load.
```

Loading the whole dataset up front (rather than per-match lazily) keeps the
app simple and works fine at this size (~2 MB); heatmap mode in particular
needs to scan across many matches at once, which is trivial in-memory but
would mean a lot of round trips if each match were a separate fetch.

## Coordinate mapping

The README's formula is:

```
u = (x - originX) / scale
v = (z - originZ) / scale
pixel_x = u * imgSize
pixel_y = (1 - v) * imgSize     (Y flipped: image origin is top-left)
```

implemented directly in `app.js` as `worldToPixel()`. Two wrinkles:

1. **The minimap files are not 1024×1024.** `AmbroseValley_Minimap.png` is
   4320×4320, `GrandRift_Minimap.png` is 2160×2158, and `Lockdown_Minimap.jpg`
   is 9000×9000 — all much larger than the README's stated size (and
   GrandRift isn't even perfectly square). I resized all three to a clean
   1024×1024 during the build step (`compact_export.py`'s companion image
   prep), so the documented formula applies exactly as written with
   `imgSize = 1024`, and the app never has to special-case per-map image
   dimensions. This also keeps the shipped asset size small (~350 KB total
   instead of ~34 MB).
2. **Elevation (`y`)** is ignored for plotting, per the README's own note.
   It's dropped entirely in `compact_export.py` to keep the dataset small;
   it wasn't needed for anything in this tool, but would be trivial to add
   back (e.g. a per-player elevation sparkline) if a future version wanted it.

I validated the mapping by eye, not just by formula: player paths in
Playback mode consistently follow roads and skirt around buildings on all
three maps (see screenshots), which wouldn't happen if the scale/origin/flip
were wrong.

## Assumptions (things the data made me decide)

| # | What I found | How I handled it |
|---|---|---|
| 1 | **`ts` is not what the README says it is.** It's typed as `TIMESTAMP_MILLIS` and described as "milliseconds elapsed within the match," but the raw integer values are actually **Unix seconds** — e.g. `1770727161` decodes to `2026-02-10 12:39:21 UTC`, which matches the file's actual `February_10` folder. Treating it as ms-since-match-start (as documented) gives sub-second "matches," which is clearly wrong; treating it as Unix seconds gives match durations of minutes, consistent with "a match lasts several minutes." | Used raw `ts` as Unix seconds. Per-match relative time = `ts - min(ts across all players in the match)`, which is what drives the playback scrubber (0 → match duration). |
| 2 | **Minimap images don't match the documented 1024×1024 size** (see above). | Resized all three to 1024×1024 at build time so the documented formula is exact. |
| 3 | **The dataset is a sample of telemetry, not full match rosters.** 1,243 files ÷ 796 matches ≈ 1.56 player-files per match on average (max 2 humans, up to 15 bots seen in one match) — far below the README's own illustrative "10 humans + 40 bots → 50 files." | Rather than implying the tool shows "everyone in the match," the UI explicitly labels tracked-player counts and includes a caveat in the match detail panel: *"Counts reflect telemetry files exported for this match, not the full player roster."* |
| 4 | **One match (`ac049b28…`) has identical files duplicated across the `February_10`/`February_11` folder boundary** — one player's file is byte-for-byte identical in both day folders, suggesting a midnight-boundary export artifact in the source telemetry pipeline. | De-duplicated on `(user_id, match_id)`, keeping the first occurrence and assigning the match to its earliest folder date. |
| 5 | **Human-vs-human combat (`Kill`/`Killed`) is extremely rare** — 3 occurrences total across all 89k rows, vs. 2,410 `BotKill` — because most tracked matches only have 0–2 humans. | Grouped `Kill`+`BotKill` into one "Eliminations" layer and `Killed`+`BotKilled` into one "Deaths" layer in the UI (both from the tracked player's point of view), rather than exposing four separate, mostly-empty toggles. |

## Major trade-offs

| Decision | Chosen approach | Alternative considered | Why |
|---|---|---|---|
| Parquet reading | Hand-rolled, dependency-free reader | `pyarrow` / `duckdb` | No network/package access in the build environment; the dependency-free version is also a nice byproduct (zero install steps to reproduce). Would switch to `pyarrow` in a normal environment. |
| Data delivery | One static `dataset.json` (~2 MB), fetched once | A small backend/API with per-match endpoints | Dataset is small enough to load wholesale; avoids running/hosting a server for a 5-day sample; heatmap aggregation across many matches is a single in-memory scan instead of N requests. Wouldn't scale to a truly large (multi-GB) telemetry set without revisiting this. |
| Heatmap rendering | Float accumulator grid + Gaussian splat, normalized by a high percentile, rendered client-side | A canvas alpha-compositing "stamp" approach | The naive stamp approach (additive alpha blending in an 8-bit canvas) saturates to solid color almost immediately once point counts exceed a few thousand — it lost all differentiation on "all matches" traffic view (~49k points). The float-array approach avoids 8-bit clipping and normalizes against the actual data range. |
| Playback granularity | Discrete position samples (~2–5s apart) with the path/marker jumping between known points | Interpolating position between samples for smoother animation | Simpler and avoids inventing motion the telemetry didn't record; the "full path always visible, faint" + "traveled-so-far, bold" combination gives context even between samples. Worth adding interpolation as a polish pass if time allowed. |
| Framework | None (vanilla JS + Canvas) | React + a charting/mapping library | No build step, smaller payload, and the actual interaction surface (filters + one canvas) doesn't need componentization. |
| Rows per match kept | All rows, coordinates rounded to 0.01 units | Downsampling dense paths | Full dataset is already small (~89k rows); downsampling wasn't needed to hit a reasonable payload size (~2 MB total). |

## Known limitations / what I'd do next with more time

- No pan/zoom on the map canvas — at 1024×1024 with a few hundred points per
  match this wasn't necessary, but it would help on Lockdown's especially
  dense central cluster.
- No cross-match player lookup (e.g. "show me every match this human
  played in") — the data supports it (human `user_id`s repeat across
  matches) but it wasn't in the core requirements.
- Position interpolation between samples for smoother playback motion.
- The dictionary/statistics fields in the Parquet metadata (min/max, etc.)
  aren't used by the reader — they weren't necessary for this dataset's
  size but would matter for larger files.
