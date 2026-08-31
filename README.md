# Khaaka — apartment plan

A hand-measured apartment floor plan, and the editor that drew it.

**[View the plan →](https://ianbeemsterboerr.github.io/floorplan/)**

## One app, two modes

There is a single codebase. Which mode you get depends on where it is served
from, so the hosted page cannot be edited by accident:

| Served from | Mode |
|---|---|
| `localhost`, `127.0.0.1` or `file://` | **Edit** — the full editor |
| Anywhere else (e.g. GitHub Pages) | **View** — read-only |

In view mode the toolbar, tabs, layers panel and file actions are removed from
the page, a mouse press can only pan, the keyboard does nothing but zoom, and
autosave and `localStorage` writes are blocked. The plan is fetched from
`app/plan.json` rather than restored from the browser.

Override either way with `?mode=edit` or `?mode=view` — handy for checking the
viewer locally.

## Running it

```bash
python3 -m http.server 5173      # then open http://localhost:5173
```

That gives you the editor. To publish a change to the plan, rebuild it and
copy it in:

```bash
node cli/khaaka.mjs run plans/house.json plans/house.khk
cp plans/house.json app/plan.json
```

## Measuring

Hover — or tap, on a phone — any wall, door, window, ruler or note. Walls
report the **clear span between the openings and walls either side**, not the
whole run, so every piece of the drawing can be measured on its own.

Drag to pan, scroll or pinch to zoom.

## Reading the plan

Rooms are lettered as they were on the original measurement sheets:

| | | | |
|---|---|---|---|
| **A** Hal | **B** Keuken | **C** Woonkamer | **D** Slaapkamer |
| **E** Hal | **F** Badkamer | **G** Berging | **K** kast · **MK** meterkast |

All dimensions are internal (clear-wall) and in millimetres. Only the spine
wall is a measured 180 mm; the other thicknesses are derived so the rooms line
up. The plumbing points are scaled off an estate-agent drawing rather than
measured, so treat those as approximate.

## Layout

| | |
|---|---|
| `app/` | The editor and viewer — `index.html`, `app.js`, `styles.css` |
| `app/plan.json` | The published plan |
| `cli/khaaka.mjs` | Build layouts from the terminal, zero dependencies |
| `plans/house.khk` | The measurements as a re-runnable script |

`plans/house.khk` is the source of truth: a plain-text list of every dimension
with the reasoning in comments. Re-running it rebuilds `house.json` from
scratch.

## Credit

Khaaka was written by [Bipul Raman](https://github.com/BipulRaman/Khaaka) and
is MIT licensed — see [LICENSE](LICENSE). This is a modified copy. Changes on
top of upstream: millimetre units, rulers that track their wall, hover-to-
measure, wall-endpoint snapping, service and note symbols, the read-only view
mode, and the command-line builder.
