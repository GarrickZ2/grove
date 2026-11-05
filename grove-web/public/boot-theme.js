// Runs before anything paints, so a page never flashes the stylesheet's dark
// default while the real theme is still on its way from the server. A machine
// switch hands the theme over in the URL: each machine is its own origin, with
// nothing in its storage yet.
(function () {
  var KEY = "grove:boot-theme";
  var COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\))$/i;
  try {
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
