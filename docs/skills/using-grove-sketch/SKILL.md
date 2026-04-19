---
name: using-grove-sketch
description: Read, create, and modify Excalidraw sketches in a Grove Studio task. Use when the user asks you to collaborate on a visual design, draw a flow, annotate a diagram, or modify shapes on a Grove task's sketch canvas.
---

# Using Grove Sketch

A Grove Studio task can hold one or more Excalidraw sketches. You have four MCP tools. The task is always the current one (derived from `GROVE_*` env vars) — **do not pass or guess `project_id` / `task_id`**:

- `grove_sketch_read_me()` — one-time element-format reference. Call it once per conversation before you draw; never call it again.
- `grove_sketch_list()` — list sketches in the current task.
- `grove_sketch_read(sketch)` — read a sketch. Returns its scene summary and a fresh `checkpoint_id`. `sketch` accepts either the name or the `sketch-<uuid>` id.
- `grove_sketch_draw(sketch, elements)` — create or modify a sketch. `sketch` accepts a name (auto-creates if missing) or an id. `elements` is a typed JSON array (see below).

## Rules

1. **Call `grove_sketch_read_me` once** at the start of any sketch work — it returns the full element schema, colors, pseudo-element grammar, and camera sizes. Don't re-call it; the content is static.
2. **Before editing an existing sketch, call `grove_sketch_read`** to get a fresh `checkpoint_id`. Pass it back as the first pseudo-element `{"type":"restoreCheckpoint","id":"<checkpoint_id>"}` so your new elements layer on top of the saved state.
3. **Without `restoreCheckpoint`, `grove_sketch_draw` starts from an empty scene** and overwrites whatever was there. That's usually not what you want.
4. **Never invent element ids.** Every real element needs a unique string `id`; pick fresh ids for additions. To modify an existing element, delete it (`{"type":"delete","ids":"<id>,<id>"}`) and re-add it under a new id in the same call.
5. **Do not edit while the user is actively drawing** — the canvas is locked server-side while the ACP chat is busy, but if a sketch was updated within the last 2 s (see `updated_at` from `grove_sketch_list`), back off briefly.

## The `elements` array

Ordered list of element objects. Array order is z-order (first = back, last = front). Three kinds:

- **Real elements**: `rectangle`, `ellipse`, `diamond`, `arrow`, `line`, `text`, `freedraw`. Each needs a unique `id`.
- **Pseudo-elements** (Grove-only, don't render as shapes):
  - `{"type":"restoreCheckpoint","id":"<cp-id>"}` — at most one; loads the referenced scene as the base.
  - `{"type":"delete","ids":"id1,id2"}` — removes those ids (and any bound-text with a matching `containerId`) from the base.
  - `{"type":"cameraUpdate","x":0,"y":0,"width":800,"height":600}` — viewport hint. Prefer 4:3 sizes.

Full element schema, color palette, camera size table, and worked examples live in `grove_sketch_read_me`. Don't guess — call the tool.

## Example: continue editing an existing sketch

```
// 1. grove_sketch_read({"sketch": "architecture"})
//    → { summary: "…", checkpoint_id: "cp-8f2…" }

// 2. grove_sketch_draw({
//      "sketch": "architecture",
//      "elements": [
//        {"type": "restoreCheckpoint", "id": "cp-8f2…"},
//        {"type": "delete", "ids": "box-old"},
//        {"type": "rectangle", "id": "box-new", "x": 100, "y": 100,
//         "width": 200, "height": 80,
//         "backgroundColor": "#a5d8ff", "fillStyle": "solid",
//         "label": {"text": "Auth", "fontSize": 20}}
//      ]
//    })
//    → { checkpoint_id: "cp-a91…", element_count: 7, … }
```

## Example: start a fresh diagram by name

```
grove_sketch_draw({
  "sketch": "user-flow",          // auto-created if absent
  "elements": [
    {"type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0},
    {"type": "rectangle", "id": "b1", "x": 100, "y": 100,
     "width": 200, "height": 100,
     "label": {"text": "Start", "fontSize": 20}},
    {"type": "rectangle", "id": "b2", "x": 450, "y": 100,
     "width": 200, "height": 100,
     "label": {"text": "End", "fontSize": 20}},
    {"type": "arrow", "id": "a1", "x": 300, "y": 150,
     "width": 150, "height": 0,
     "points": [[0, 0], [150, 0]], "endArrowhead": "arrow",
     "startBinding": {"elementId": "b1", "fixedPoint": [1, 0.5]},
     "endBinding":   {"elementId": "b2", "fixedPoint": [0, 0.5]}}
  ]
})
```

## Failure modes

- **"checkpoint '<id>' not found"** — the LRU (100 most recent) rotated out. Call `grove_sketch_read` to get a fresh `checkpoint_id`.
- **"duplicate element id"** / **"element id … conflicts with an existing element"** — pick a new id, or include the old id in a `delete` pseudo-element first.
- **"elements array exceeds 10000 item limit"** — split the draw into several calls chained via `restoreCheckpoint`.
- **"invalid sketch id"** — you passed something that isn't a name and isn't a `sketch-<uuid>`. Use `grove_sketch_list` to see what exists.
