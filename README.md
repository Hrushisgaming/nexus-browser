# Nexus + Helium: combined source (Helium 0.19.2.1, Chromium 155.0.8059.39)

Two parts, side by side:

1. helium-macos/  - the official Helium macOS build repo (github.com/imputnet/helium-macos, tag 0.19.2.1, commit f72c3d7).
   helium-macos/helium-chromium/ - the official Helium patch set and tooling (github.com/imputnet/helium, commit 9aa23f3),
   which is the submodule helium-macos expects at that path. Both are GPL-3.0 (see their LICENSE files);
   code imported from ungoogled-chromium keeps its BSD 3-Clause license (LICENSE.ungoogled_chromium).
2. nexus-rebrand/ - the Nexus changes (rebrand, setup-page logo, "Chat with Nexus" side panel extension, Nexus Vault, Nexus Authenticator, Proton VPN helper,
   build script). Everything here is plain-text source you can edit.

What is NOT in this archive: the Chromium source itself. Helium is a set of patches applied to Chromium, and helium-macos downloads
Chromium (about 155.0.8059.39, tens of GB once unpacked) when you build. See helium-macos/docs/building.md. Building takes hours.

How the Nexus changes are applied: they are NOT patches to the Chromium source. nexus-rebrand/build_nexus_dmg.sh takes a finished
Helium .dmg (put it in nexus-rebrand/base/, or let it fetch one), rewrites resources (icons, setup page, names), adds the extensions,
and writes Nexus.dmg. So the quick way to get Nexus is the Helium DMG + nexus-rebrand. Compiling Helium yourself only matters if you want
to change the native browser (for example putting a button inside the tab strip), and then your own Nexus changes would be added as
patches under helium-macos/helium-chromium/patches/.

Native Ask Nexus button (tab strip) is in NATIVE_ASK_NEXUS.md: a source patch for Helium, written but not yet compiled.

Licensing: if you give a Nexus build to other people, keep the GPL-3.0 licenses and make the source of your changes available to them.

Native built-in Vault, Authenticator and Proton VPN (compiled in like uBlock Origin) is in NATIVE_VAULT_VPN.md: a source patch for Helium, written but not yet compiled.
