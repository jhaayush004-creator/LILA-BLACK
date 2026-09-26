# Insights

Three things the tool surfaced once real data was loaded into it, each with
the evidence behind it and what a Level Designer could do with it.

---

## 1. Ambrose Valley dominates map selection — every single day, not just on average

**What caught my eye:** Filtering by map in the tool, Ambrose Valley's match
count dwarfs the other two maps. Switching the Date filter through each of
the 5 days to check whether this was a one-day fluke, the skew holds
steady day after day.

**The pattern:**

| Date | Ambrose Valley | Lockdown | Grand Rift |
|---|---|---|---|
| Feb 10 | 70% | 21% | 8% |
| Feb 11 | 68% | 25% | 6% |
| Feb 12 | 78% | 16% | 6% |
| Feb 13 | 70% | 26% | 4% |
| Feb 14 (partial) | 65% | 14% | 22%* |

*(Feb 14 is a partial day with only 37 matches total, so this figure is noisy — 8 matches.)*

Across the full 5-day, 796-match sample: **Ambrose Valley = 71%, Lockdown =
21%, Grand Rift = 7%.** This isn't a trend that's shifting over time — it's
a consistent, stable preference (or matchmaking bias) toward one map, every
day, from day one.

**What's actionable, and what it affects:** If this reflects genuine player
preference, Grand Rift is a candidate for a content refresh (new POIs,
layout pass) or a rotation-weighting change to force more exposure before
concluding players actively dislike it — a map that's rarely played also
gets little tuning signal, which can become self-reinforcing. If instead
this reflects a matchmaking/queue-selection default (e.g. players not
actively choosing Grand Rift because it's buried in a menu, or queue times
favor the most populated map), that's a UX fix, not a level-design one — and
worth ruling out before touching Grand Rift's design. Metrics to watch after
any change: match count share, and whether Grand Rift's own match durations
and elimination rates (currently in line with the other two maps — see the
tool's per-map stats) hold up once exposure increases.

**Why a Level Designer should care:** balance and iteration effort naturally
follows play volume. A map stuck at 7% of matches gets 7% of the real-world
playtesting signal that Ambrose Valley gets, which compounds — it's harder
to justify investing in Grand Rift's next pass if the data suggests almost
nobody sees it, but it's also hard to know if that "nobody plays it" is
cause or effect without isolating whether it's a preference or a pipeline
default.

---

## 2. Eliminations on Ambrose Valley cluster overwhelmingly around a single hotspot

**What caught my eye:** Turning on the Heatmap mode with "Elimination
zones" + "All matches" for Ambrose Valley, almost the entire map stays cold
except for one bright, tight cluster near the central compound — and the
same location lights up again under "Death zones" and "High traffic."

**The pattern:** Of 1,794 elimination events recorded on Ambrose Valley,
**57% occur within a ~130-unit radius of a single point** near the central
building cluster (and 73% within a ~175-unit radius of that same point).
The high-traffic heatmap shows the same location as one of the hottest
loot/movement zones on the map — this isn't a coincidence of two unrelated
patterns; it's the same location driving both.

**What's actionable, and what it affects:** This is the signature of a "hot
drop" — a location valuable enough (loot density, sightlines, or simply
central position) that a large fraction of all matches route through it,
and consequently a large fraction of all fights happen there too. That's
not automatically a problem (hot drops are a known, sometimes intentional,
battle-royale pattern), but it's worth a deliberate decision rather than an
accidental one: if the goal is spread-out, varied engagements across the
map, redistributing some of that location's loot value to 2–3 secondary
POIs (visible as cooler zones in the same heatmap) would be the direct lever
— watch the elimination heatmap's concentration percentage (currently 57%
within radius) as the metric to see if it flattens out. If a central hot
drop is the intended design, this same heatmap is the tool to confirm the
secondary POIs are still getting meaningful traffic rather than being
totally dead space (right now, several visible cold zones toward the map's
edges get near-zero traffic across all 566 matches).

**Why a Level Designer should care:** this is exactly the "where do fights
break out, and which areas get ignored" question the tool was built to
answer, and it answers it concretely: one small area, not the whole map, is
carrying most of the combat design's actual weight.

---

## 3. The storm barely kills anyone — it's a rounding error next to bot combat

**What caught my eye:** Looking at the Events panel across dozens of
matches, "Storm deaths" is almost always 0, occasionally 1. Aggregating
across the whole dataset confirms it's not just the matches I happened to
sample.

**The pattern:** Across all 796 matches, `KilledByStorm` occurs **39
times total — an average of 0.05 storm deaths per match** (roughly 1 in
every 20 matches has a single storm death, and essentially none have more
than one). By contrast, bot-related combat (`BotKill` + `BotKilled`) totals
3,109 events. Storm deaths make up **just 1.2% of all combat/elimination
events** in the dataset. For a mechanic whose stated purpose is to force
players to keep moving and eventually collide with each other, it is
almost never the actual thing that ends a player's match.

**What's actionable, and what it affects:** this points at storm pacing —
either the shrink timing/damage is tuned lenient enough that attentive
players simply never get caught by it, or match durations are short enough
(6–7 minutes average) relative to the shrink schedule that most matches
resolve (via extraction or combat) before the storm becomes a real threat.
If the design intent is "the storm should be a meaningful source of
pressure/death," the direct levers are shrink speed, per-tick damage, or
starting the shrink earlier relative to average match length — and this
same event-count breakdown (storm deaths ÷ total match count) is the metric
to move and re-check after any tuning pass. If, instead, the storm is meant
purely as a soft "keep moving" nudge rather than a real killer, this number
suggests it's already succeeding at that narrower job and doesn't need
changing.

**Why a Level Designer should care:** it's easy to assume a shrinking-zone
mechanic is "doing work" just because it exists and matches end in time.
This number tests that assumption directly, and — combined with the
per-map storm-death heatmap in the tool, which shows where the few storm
deaths do happen — shows whether the zone shape/pacing interacts
differently with different maps' geometry (e.g. Lockdown's tighter
interior vs. Ambrose Valley's open terrain).
