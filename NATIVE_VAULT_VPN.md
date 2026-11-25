# Built-in Nexus Vault, Nexus Authenticator and Proton VPN (level 3: compiled into the browser, like uBlock Origin)

Patch: helium-macos/patches/nexus/builtin-vault-vpn.patch  (listed at the end of helium-macos/patches/series)
Staging script: helium-macos/nexus_stage_builtin.py (called from helium_resources() in devutils/shared.sh, so ./build.sh runs it)

## What it does
- Nexus Vault, Nexus Authenticator and Proton VPN are packed into the browser's resource bundle and registered as component extensions, the same way
  Helium does it for uBlock Origin (third_party/nexus_builtin  <->  third_party/ublock). Nothing is loaded at start-up, there is no
  --load-extension, no launcher for them and no unpacked folder.
- All three are pinned to the toolbar by default (default value of the extensions.pinned_extensions pref, next to uBlock).
- They show up in nexus://extensions as "Nexus component", like uBlock does.
- They are NOT given the extra powers of Chrome's own component extensions (run on every page, bypass policy, every API). Helium's uBlock
  patches already turn those off for uBlock; this patch makes `Manifest::IsUBlockComponent()` also true for the three Nexus built-ins so
  the same rules apply. The few uBlock-only behaviours (webRequest promise support, managed-storage asset settings) still use the exact
  uBlock check (`IsUBlockOriginComponent`).
- Ids: Vault `aideengppkjlkhmlfabkigdahhogfbdi` (from the key in nexus-vault/manifest.json), Proton VPN `jplgfhpmjnbigmhklmmbgecoobifkmpa`
  (its Chrome Web Store id; the staging script adds the store key to the manifest), Nexus Authenticator `akbamahfimlndcjkkonndelmldbnmefd`
  (from the key in nexus-authenticator/manifest.json). If a key changes, change
  components/helium_services/nexus_extension_ids.h in the patch too (the hashed ids are SHA1 of the id, upper-case).

## Files changed
third_party/nexus_builtin/{BUILD.gn,generate_file_list.py,README.chromium} (vault/, proton_vpn/, authenticator/), components/helium_services/nexus_extension_ids.h,
chrome/browser/extensions/{component_loader.{h,cc},chrome_component_extension_resource_manager.cc,BUILD.gn},
chrome/browser/extensions/component_extensions_allowlist/allowlist.cc, chrome/chrome_paks.gni, tools/gritsettings/resource_ids.spec,
extensions/common/manifest.h, extensions/browser/extension_prefs.cc, and one-line changes in extensions/renderer/api/web_request_natives.cc
and extensions/browser/api/storage/storage_frontend.cc.

## Status: NOT compiled
`git apply --check` passes on Chromium 155.0.8059.39 with all of Helium 0.19.2.1's patches applied first (9 of Helium's flag/layout patches
did not apply in my partial copy of the tree; none touch these files). Every signature used was checked against the headers. It has NOT been
compiled or run. The staging script was tested with a fake extension file, not the real Proton VPN download (the real one could not be
fetched where I work).

## Build it
1. ./build.sh in helium-macos/ as before. The first build downloads the Proton VPN extension into nexus-rebrand/vendor/proton-vpn.crx
   (or put it there yourself; `nexus-rebrand/build_nexus_dmg.sh --refresh-proton` also fetches it).
2. Put the resulting Helium .dmg in nexus-rebrand/base/ and run  ./build_nexus_dmg.sh --native
   (--native = Vault and Proton VPN are already inside, so only Chat with Nexus is added by the launcher; without it you would get both copies).
3. Do NOT use --native with a stock Helium .dmg: that one has no built-in Vault/VPN.

## Things to know
- The built-in Vault is a different extension from a "Load unpacked" Vault already in your profile if its id differed; export/import steps are in
  nexus-vault/README.txt.
- If you installed Proton VPN with install_proton_vpn.command or the Web Store earlier, that copy has the same id as the built-in one.
  Remove it (nexus://extensions) before first run of the native build, or you may see two entries.
- Proton VPN updates now only come with new Nexus builds (build with --refresh-proton). Check Proton's licence terms before giving
  builds to other people.
- Vault is Manifest V3 with a service worker, and Proton VPN uses the proxy API. Both should work as components, but this is untested.
- Nexus Authenticator (source: nexus-rebrand/nexus-authenticator, also usable as a plain Chrome extension) is Manifest V3 with a classic
  service worker. As a component it needs: `chrome.tabs.captureVisibleTab` + `chrome.scripting.executeScript` under `activeTab`
  (scanning a QR code on the page, shortcut Alt+Shift+Q), `chrome.storage.session`, `chrome.alarms` and `chrome.action.openPopup`.
  These are ordinary extension APIs and were not changed by the patch, but this has NOT been run as a built-in. First thing to try after a
  build: add a QR code from the page with "Select area on page", then lock and unlock the vault.
- The standalone Chrome version of the Authenticator has the SAME id as the built-in one. If you loaded it unpacked into Nexus earlier,
  first download an encrypted backup there (Export > Download backup), remove it at nexus://extensions, then restore the backup in the built-in
  one (Export > Restore backup). Its data is per extension id, so the built-in copy starts empty otherwise.
- Limits: up to 1400 files for all three extensions together (about 30 are used today; the staging script stops with a message if it is more).
