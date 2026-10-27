# Grove application icons

The install-time icon remains the original Grove mark (`icon.icns`, `icon.ico`,
and the PNG sizes in this directory). Runtime icon choices live in `variants/`.

## Editable sources and generated assets

- `grove-web/public/app-icons/<design>-<light|dark>.svg`: editable SVG masters,
  used directly by the Appearance picker and browser favicon.
- `variants/catalog.json`: the single catalog shared by Rust and TypeScript.
- `variants/<design>-<light|dark>.png`: 1024px native assets derived from the SVGs,
  with transparent margins for desktop icon sizing. Embedded into GUI builds.
- `variants/<design>-<light|dark>-tray.png`: 64px assets for the menu bar/tray,
  cropped to the icon face so desktop padding does not shrink the status icon.
- `docs/app-icons/collection.png`: a contact sheet of every edition.

There are twelve designs: Classic, Canopy, Orbit, Prism, Constellation, Moss,
Terrarium, Origami, Pixel Grove, Bamboo, Firefly, and Treehouse.
Classic preserves the existing SVG artwork.

Regenerate the SVGs, native PNGs, and contact sheet with
`scripts/generate-app-icons.mjs`. It requires the `sharp` Node package; when it
is not installed alongside the script, set `GROVE_SHARP_MODULE` to an absolute
path to its module entry point before running `node scripts/generate-app-icons.mjs`.
The new artwork is authored in that script; preserve corresponding edits there
when revising a generated SVG.

## Preferences and desktop behavior

`theme.app_icon` stores the catalog ID in backend `~/.grove/config.toml`.
The light/dark edition always follows the resolved Grove color theme. There is
no separate icon appearance setting. Existing files default to `classic`; stale
`app_icon_mode` keys from earlier versions are ignored.
The config PATCH API rejects unknown IDs.

- macOS: update the running application's Dock icon through AppKit on the main
  thread, loading the PNG directly from memory.
- Windows/Linux: use Tauri's window icon API for every running app window.
- Browser: use the corresponding SVG favicon.

Pinned Windows shortcuts and Linux launchers that obtain their icon from the
installed executable or `.desktop` file can retain the install-time icon. This
setting changes running icons; it does not rewrite installed bundles, shortcut
files, or system icon caches. Dock/window, menu bar/tray, browser favicon and
settings previews use the same design and automatically follow the interface theme.
