// Runs before anything paints, so a page never flashes the stylesheet's dark
// default while the real theme is still on its way from the server. A machine
// switch hands the theme over in the URL: each machine is its own origin, with
// nothing in its storage yet. The installed-app icon links are set here too, so
// they are already right while the document is still being parsed.
(function () {
  var KEY = "grove:boot-theme";
  var COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\))$/i;
  try {
    var icon = localStorage.getItem("grove:boot-icon");
    if (/^[a-z]+-(light|dark)$/.test(icon || "")) {
      var touchIcon = document.querySelector("link[rel='apple-touch-icon']");
      var manifest = document.querySelector("link[rel='manifest']");
      if (touchIcon) touchIcon.setAttribute("href", "/app-icons/pwa/" + icon + ".png");
      if (manifest) manifest.setAttribute("href", "/app-icons/pwa/" + icon + ".webmanifest");
    }
    var raw = null;
    var match = location.hash.match(/^#grove-boot=([^&]*)/);
    if (match) {
      raw = decodeURIComponent(match[1]);
      localStorage.setItem(KEY, raw);
      history.replaceState(null, "", location.pathname + location.search);
    }
    var theme = JSON.parse(raw || localStorage.getItem(KEY) || "null");
    if (!theme) return;
    var root = document.documentElement;
    Object.keys(theme.vars).forEach(function (name) {
      if (name.indexOf("--color-") === 0 && COLOR.test(theme.vars[name])) {
        root.style.setProperty(name, theme.vars[name]);
      }
    });
    root.dataset.theme = theme.light ? "light" : "dark";
  } catch (error) {
    // Storage can be unavailable; the stylesheet's default still works.
  }
})();
