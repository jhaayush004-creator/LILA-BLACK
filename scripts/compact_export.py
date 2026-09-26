import json

RAW = "/home/claude/work/build/raw_matches.json"
OUT = "/home/claude/work/build/dataset.json"

MAP_CONFIG = {
    "AmbroseValley": {"scale": 900, "originX": -370, "originZ": -473, "name": "Ambrose Valley"},
    "GrandRift": {"scale": 581, "originX": -290, "originZ": -290, "name": "Grand Rift"},
    "Lockdown": {"scale": 1000, "originX": -500, "originZ": -500, "name": "Lockdown"},
}

DATES = ["February_10", "February_11", "February_12", "February_13", "February_14"]
DATE_IDX = {d: i for i, d in enumerate(DATES)}

EVENT_NAMES = ["Position", "BotPosition", "Kill", "Killed", "BotKill", "BotKilled", "KilledByStorm", "Loot"]

matches_raw = json.load(open(RAW))

out_matches = []
for match_id, m in matches_raw.items():
    all_ts = []
    for p in m["players"].values():
        for row in p["rows"]:
            all_ts.append(row[0])
    if not all_ts:
        continue
    t0 = min(all_ts)
    dur = max(all_ts) - t0

    counts = {"kill": 0, "killed": 0, "botkill": 0, "botkilled": 0, "storm": 0, "loot": 0}
    players_out = []
    n_humans = 0
    n_bots = 0
    for uid, p in m["players"].items():
        if p["is_bot"]:
            n_bots += 1
            short_id = uid  # numeric bot ids are already short
        else:
            n_humans += 1
            short_id = uid[:8]
        rows_out = []
        for (ts, x, z, y, code) in p["rows"]:
            t_rel = ts - t0
            rows_out.append([t_rel, x, z, code])
            name = EVENT_NAMES[code]
            if name == "Kill":
                counts["kill"] += 1
            elif name == "Killed":
                counts["killed"] += 1
            elif name == "BotKill":
                counts["botkill"] += 1
            elif name == "BotKilled":
                counts["botkilled"] += 1
            elif name == "KilledByStorm":
                counts["storm"] += 1
            elif name == "Loot":
                counts["loot"] += 1
        players_out.append({"id": short_id, "bot": p["is_bot"], "rows": rows_out})

    out_matches.append({
        "id": match_id.replace(".nakama-0", "")[:8],
        "fullId": match_id.replace(".nakama-0", ""),
        "map": m["map_id"],
        "date": DATE_IDX[m["date"]],
        "startTs": t0,
        "dur": dur,
        "humans": n_humans,
        "bots": n_bots,
        "counts": counts,
        "players": players_out,
    })

# sort matches by date then start time for a stable, sensible default order
out_matches.sort(key=lambda m: (m["date"], m["startTs"]))

dataset = {
    "maps": MAP_CONFIG,
    "dates": DATES,
    "eventNames": EVENT_NAMES,
    "matches": out_matches,
}

with open(OUT, "w") as f:
    json.dump(dataset, f, separators=(",", ":"))

import os
size = os.path.getsize(OUT)
print(f"Wrote {OUT}: {size/1024:.1f} KB ({size/1024/1024:.2f} MB)")
print("Total matches:", len(out_matches))
