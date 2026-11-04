# nexus://ai, nexus://convert and the Ask Nexus button look

Patches (all end of helium-macos/patches/series):
- nexus/native-ask-button-style.patch   the "Ask Nexus" button is now icon + words, like Chrome's "Ask Gemini"
- nexus/nexus-internal-pages.patch      nexus://ai and nexus://convert are real pages of the browser

Status: NOT compiled. Each patch was checked with `git apply` against the Chromium 155.0.8059.39 files with all of Helium's
patches applied, and the APIs used were read from the sources at that tag. Nobody has run them.

## Ask Nexus button
- Why it was only a crosshair: `TabStripControlButton` always asks for a 28x28 box, so the words "Ask Nexus" were cut off.
  Chrome's Ask Gemini uses `TabStripNudgeButton`, which sizes itself to icon + label. Both Ask Nexus buttons now use that class,
  opened to full width (`SetWidthFactor(1)`) and without a close button.
- Vertical tabs (and compact / dynamic): the button is in the toolbar, directly left of the profile picture. That placement was
  already in native-ask-button-vertical.patch; if it did not show in your build, that build probably did not contain the
  patch yet (it is in the series now). In a narrow window the whole button drops out instead of squashing the address bar.
- Classic horizontal tabs: right end of the tab row, as before.

## nexus://ai and nexus://convert
- Helium shows chrome:// as nexus://, so inside the browser these are chrome://ai and chrome://convert. A URL handler rewrites them to
  `chrome-extension://<id>/ai.html` (Chat with Nexus, id iokkgaheigikheidihfidjdkocoaplco) and `.../index.html`
  (Convert with Nexus, id pgbljlnilnkifmkocgkemphhlnnbnfnl). The address bar keeps showing nexus://ai / nexus://convert.
- Without the native build (build_nexus_dmg.sh route) the address bar shows the real extension address after the redirect; the
  names still work because each extension redirects them.
- "Convert to it!" is github.com/p2r3/convert (GPL-2.0). Build it into the app with `nexus-rebrand/fetch_convert.sh` (needs bun).
  The GitHub Actions build runs it automatically (a failure there does not fail the build; the extension is then just left out).
