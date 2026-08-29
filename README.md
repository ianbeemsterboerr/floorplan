# Floor plan

A read-only view of a single apartment floor plan, measured by hand and drawn
with [Khaaka](https://github.com/ianbeemsterboerr/Khaaka).

**[View the plan →](https://ianbeemsterboerr.github.io/floorplan/)**

## What you can do

- **Hover anything to measure it.** Walls report the clear span between the
  openings and other walls either side of them, not the whole run. Doors,
  windows and rulers report their own length.
- **Drag** to pan, **scroll** or **pinch** to zoom, **+ / −** and **Fit** in
  the header. Works the same with a finger as with a mouse.
- On touch, **tap** an object instead of hovering it.

That is the entire feature set. There are no tools, no selection and no
editing paths in this page, so the drawing cannot be changed from here.

## Files

| | |
|---|---|
| `index.html` | The page |
| `viewer.js`  | Canvas renderer, ported from the Khaaka editor so both draw identically |
| `plan.json`  | The layout — the same format the Khaaka editor opens |

## Reading the plan

Rooms are lettered as they were on the original measurement sheets:

| | | | |
|---|---|---|---|
| **A** Hal | **B** Keuken | **C** Woonkamer | **D** Slaapkamer |
| **E** Hal | **F** Badkamer | **G** Berging | **K** kast · **MK** meterkast |

All dimensions are internal (clear-wall) and in millimetres. Ceiling heights
are noted above the drawing.
