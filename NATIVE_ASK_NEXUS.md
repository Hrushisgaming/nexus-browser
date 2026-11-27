# Native "Ask Nexus" button (level 3: compiled into the browser)

Patch: helium-macos/patches/nexus/native-ask-button.patch  (already listed at the end of helium-macos/patches/series)

## What it does
- Adds an "Ask Nexus" button (crosshair icon + label, same style as Chrome's Ask Gemini button) at the RIGHT END of the
  horizontal tab strip. It is outside the tabs: with many tabs the tabs shrink and the button keeps its size.
- Click = open/close the "Chat with Nexus" side panel (extension id iokkgaheigikheidihfidjdkocoaplco, fixed by the key in
  nexus-chat/manifest.json; if you ever change that key, change the id in horizontal_tab_strip_region_view.cc too).
- Three-dot menu: new check item "Show Ask Nexus" (above Settings) turns the button on or off. Stored in the profile
  pref nexus.ask_button_shown (default: on).
- New vector icon chrome/app/vector_icons/nexus_crosshair.icon.

Files changed: chrome/app/vector_icons/{BUILD.gn,nexus_crosshair.icon}, chrome/browser/ui/tabs/tab_strip_prefs.{h,cc},
chrome/browser/ui/toolbar/app_menu_model.cc, chrome/browser/ui/views/frame/horizontal_tab_strip_region_view.{h,cc}.

## Status: NOT compiled
Written against the exact Chromium 155.0.8059.39 files with Helium 0.19.2.1's patches applied first. `git apply --check`
passes on that tree, and every API used was checked against the headers at that tag. It has NOT been compiled or run (a Chromium
build needs a Mac and hours). Expect that the first build might stop on a small compile error; the error message will name
the line, and the patch is only ~280 lines.

## Not covered
- Vertical tabs / zen layouts: they use a different region view, so no button there (use the toolbar crosshair or the in-page pill).
- Dragging the button, a bottom-left dock, and choosing docked vs floating. Those would be more C++.
- If the three-dot menu in this build is the newer web-based one, the "Show Ask Nexus" item may not appear (the button itself will).
- Chromium's alternative tab strip ("tab strip unification" feature) is not patched; Helium uses the classic one by default.

## Build it
1. Follow helium-macos/docs/building.md (macOS 12+, Xcode 26, Homebrew deps). Needs roughly 100+ GB free and several hours.
2. From helium-macos/: ./build.sh   (this applies the patches, including the Nexus one, and produces a Helium .dmg)
3. Put that .dmg in nexus-rebrand/base/ and run nexus-rebrand/build_nexus_dmg.sh to rebrand it into Nexus.dmg.
   (nexus_patch.py edits resources by content, so it should work on your own build; if it complains, send me the message.)
4. If the compile fails: send me the first error lines and I'll fix the patch.

## Update: visible in vertical/dynamic/compact layouts, oval style, AI Mode
- helium-macos/patches/nexus/native-ask-button-pill.patch (last line of patches/series): gives the toolbar Ask Nexus button a
  rounded tonal fill with a thin outline (the Ask Gemini look) and side margins, re-checks its visibility on every toolbar layout
  (the layout state can settle after the first check), and compares against the overflow layout's CanBeVisible() instead of
  GetVisible() so a narrow window cannot make it flip back and forth.
  NOT compiled. If it does not apply or compile, remove its line from patches/series and send the first error lines.
  The colors/APIs used: ui::kColorSysTonalContainer, ui::kColorSysTonalOutline, views::CreateRoundedRectBackground/Border.
- AI Mode search option: the "Chat with Nexus" extension (1.7.0) now has an address-bar keyword. Type "ai", press Space or Tab,
  type a question and press Enter: it opens nexus://ai (the full-tab chat) and sends the question. Extension-only, no Chromium patch.
  Helium removes Chrome's own Google "AI Mode" button from the address bar dropdown; this keyword is Nexus's replacement.

## Update 2026-11-27: toolbar button never showed + no fill/color
- Why it was missing in vertical/compact/dynamic: the pill patch only called SetVisible() when
  `layout_manager_->CanBeVisible(button)` differed from the wanted state, and CanBeVisible stays true for a button that
  was added hidden, so it never turned visible. The pill patch no longer touches UpdateNexusAskButton (back to a plain
  SetVisible from UpdateToolbarLayout / the pref observer, never from a layout pass).
- Why it had no fill: Helium maps kColorNewTabButtonCRBackground* to the flat toolbar color and the nudge button uses
  those ids. Both buttons (tab strip and toolbar) now set their own color ids: tonal blue fill, blue crosshair + label
  (Set{Background,Foreground}Frame{Active,Inactive}ColorId + UpdateColors). The toolbar one also gets a thin tonal outline.
- NOT compiled. If the build breaks, send the first error lines.
