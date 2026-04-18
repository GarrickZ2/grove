---
name: using-grove-sketch
description: Read, create, and modify Excalidraw sketches in a Grove Studio task. Use when the user asks you to collaborate on a visual design, draw a flow, annotate a diagram, or modify shapes on a Grove task's sketch canvas.
---

# Using Grove Sketch

A Grove Studio task can hold one or more Excalidraw sketches. You have five MCP tools for working with them:

- `grove_sketch_list(project_id, task_id)` — list sketches in the task
- `grove_sketch_new(project_id, task_id, name)` — create an empty sketch
- `grove_sketch_read(project_id, task_id, sketch_id)` — read the current scene
- `grove_sketch_patch(project_id, task_id, sketch_id, created?, updated?, deleted?)` — element-level changes
- `grove_sketch_replace(project_id, task_id, sketch_id, scene)` — overwrite the whole scene

## Rules

1. **Always `grove_sketch_read` before modifying.** Ids are fresh per sketch; stale ids corrupt the scene. Do not cache.
2. **Prefer `grove_sketch_patch` for small changes, `grove_sketch_replace` for structural rewrites.** A patch with 20+ updates is a strong signal to replace instead.
3. **Do not modify an element whose `updated` timestamp is within the last 2 seconds.** The user is likely mid-edit; overwriting will drop their keystroke.
4. **Never invent element ids.** For `created` use new ids you generate (UUIDv4 string, or any unique string); for `updated` and `deleted` use ids you got from `grove_sketch_read`.

## Element schema (reduced)

Excalidraw's full element has many fields; in practice you only need these:

```jsonc
{
  "id": "<unique string>",
  "type": "rectangle" | "ellipse" | "diamond" | "arrow" | "line" | "text" | "freedraw",
  "x": 0,          // number, top-left
  "y": 0,          // number, top-left
  "width": 100,    // number
  "height": 60,    // number
  "angle": 0,      // radians, usually 0
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid" | "hachure" | "cross-hatch",
  "strokeWidth": 1,
  "strokeStyle": "solid" | "dashed" | "dotted",
  "roughness": 1,
  "opacity": 100,

  // Only for "text":
  "text": "…",
  "fontSize": 20,
  "fontFamily": 1,   // 1 = Virgil (hand), 2 = Helvetica, 3 = Cascadia

  // Only for "arrow" / "line":
  "points": [[0, 0], [100, 0]],
  "startBinding": { "elementId": "<id>", "focus": 0, "gap": 1 } | null,
  "endBinding":   { "elementId": "<id>", "focus": 0, "gap": 1 } | null
}
```

Unlisted fields (e.g. `seed`, `versionNonce`, `roundness`, `groupIds`) can be omitted in your output — the backend fills them with sensible defaults when merging into the scene.

## Patch semantics

```jsonc
{
  "created": [ /* full element objects to append */ ],
  "updated": {
    "<existing-id>": { /* partial: only the fields you want to change */ }
  },
  "deleted": [ "<existing-id>", "<existing-id>" ]
}
```

`updated` is a **shallow merge**. To change a shape's color, send `{"strokeColor":"#e03131"}`, not the full shape.

## Example: add a labelled rectangle

```jsonc
grove_sketch_patch({
  "project_id": "…",
  "task_id": "…",
  "sketch_id": "sketch-<uuid>",
  "created": [
    { "id": "box-login",  "type": "rectangle", "x": 100, "y": 100, "width": 160, "height": 80 },
    { "id": "text-login", "type": "text",      "x": 120, "y": 130, "width": 120, "height": 30,
      "text": "Login", "fontSize": 20, "fontFamily": 1 }
  ]
})
```

## Example: connect two existing boxes with an arrow

After `grove_sketch_read` returns ids `box-a` and `box-b`:

```jsonc
grove_sketch_patch({
  ...,
  "created": [
    {
      "id": "arrow-a-b", "type": "arrow",
      "x": 0, "y": 0, "width": 200, "height": 0,
      "points": [[0, 0], [200, 0]],
      "startBinding": { "elementId": "box-a", "focus": 0, "gap": 1 },
      "endBinding":   { "elementId": "box-b", "focus": 0, "gap": 1 }
    }
  ]
})
```

## When to replace instead of patch

- Reorganizing the entire canvas (e.g., laying out a new architecture after the user said "redraw this as …")
- More than ~20 element changes in one turn
- Changing the `appState` (background color, grid) in addition to elements

For replace, build a full scene object:

```jsonc
{
  "type": "excalidraw",
  "version": 2,
  "source": "grove",
  "elements": [ /* … */ ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": {}
}
```

## Failure modes

- **"invalid sketch id"** — the id you passed doesn't match `sketch-<uuid>`. Call `grove_sketch_list` to get valid ids.
- **"sketch not found"** — the sketch was deleted since your last list. Refresh.
- **Silent no-op on an update** — the element id doesn't exist in the scene. Read first.
