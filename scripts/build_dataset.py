import os
import re
import sys
import json
import time
import traceback

sys.path.insert(0, "/home/claude/work")
from mini_parquet import read_parquet_rows

ROOT = "/home/claude/work/player_data/player_data"
DAYS = ["February_10", "February_11", "February_12", "February_13", "February_14"]

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

EVENT_CODES = {
    "Position": 0,
    "BotPosition": 1,
    "Kill": 2,
    "Killed": 3,
    "BotKill": 4,
    "BotKilled": 5,
    "KilledByStorm": 6,
    "Loot": 7,
}

errors = []
total_files = 0
total_rows = 0
duplicate_files_skipped = 0
seen_player_match = {}  # (match_id, user_id) -> day it was first seen

# matches[match_id] = {
#   map_id, date,
#   players: { user_id: {is_bot, rows: [ (ts,x,z,y,event_code), ... ]} }
# }
matches = {}

t0 = time.time()
for day in DAYS:
    day_dir = os.path.join(ROOT, day)
    files = os.listdir(day_dir)
    for fn in files:
        if fn.startswith("."):
            continue
        path = os.path.join(day_dir, fn)
        total_files += 1
        try:
            rows = read_parquet_rows(path)
        except Exception as e:
            errors.append((path, str(e), traceback.format_exc()))
            continue
        if not rows:
            continue
        user_id = rows[0]["user_id"]
        match_id = rows[0]["match_id"]
        map_id = rows[0]["map_id"]
        is_bot = not bool(UUID_RE.match(user_id))

        pm_key = (match_id, user_id)
        if pm_key in seen_player_match:
            # Duplicate (user_id, match_id) file, seen under a different/same
            # day folder -- observed for one match straddling the Feb 10/11
            # folder boundary with byte-identical rows. Keep the first
            # occurrence (earliest day) and skip this redundant copy.
            duplicate_files_skipped += 1
            continue
        seen_player_match[pm_key] = day
        total_rows += len(rows)

        m = matches.setdefault(
            match_id, {"map_id": map_id, "date": day, "players": {}}
        )
        # a match should be entirely on one map; flag genuine anomalies only
        if m["map_id"] != map_id:
            errors.append((path, f"map mismatch for match {match_id}", ""))

        p = m["players"].setdefault(user_id, {"is_bot": is_bot, "rows": []})
        for r in rows:
            ev = r["event"]
            code = EVENT_CODES.get(ev)
            if code is None:
                errors.append((path, f"unknown event type {ev!r}", ""))
                continue
            p["rows"].append((int(r["ts"]), round(r["x"], 2), round(r["z"], 2), round(r["y"], 2), code))

elapsed = time.time() - t0
print(f"Processed {total_files} files, {total_rows} rows in {elapsed:.1f}s")
print(f"Unique matches: {len(matches)}")
print(f"Duplicate (user,match) files skipped: {duplicate_files_skipped}")
print(f"Errors: {len(errors)}")
for e in errors[:20]:
    print(" ERR:", e[0], e[1])

# sort each player's rows by ts
for m in matches.values():
    for p in m["players"].values():
        p["rows"].sort(key=lambda r: r[0])

os.makedirs("/home/claude/work/build/data", exist_ok=True)
with open("/home/claude/work/build/raw_matches.json", "w") as f:
    json.dump(matches, f)
print("Wrote raw_matches.json:", os.path.getsize("/home/claude/work/build/raw_matches.json") / 1024 / 1024, "MB")
