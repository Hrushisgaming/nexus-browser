NEXUS BUILD KIT  (Helium 0.19.2.1 base)

BUILD (on a Mac with python3: run "xcode-select --install" once if needed)
    cd nexus-rebrand
    ./build_nexus_dmg.sh
  That is all. The Helium base is in base/, so nothing needs to be downloaded except the Proton VPN extension on the very first build
  (it is then kept in vendor/). Result: Nexus.dmg next to the script.

WHAT IS BUILT INTO Nexus.app
  - everything "Helium" renamed to "Nexus", with the Nexus icons
  - Chat with Nexus (AI side panel + the "Ask Nexus" page button, with a master switch in its settings, default on)
  (the crosshair is its icon everywhere: toolbar, panel header, "Ask Nexus" button)
  - Nexus Vault (passwords). Moving from the old loose Vault? See nexus-vault/README.txt first.
  - Nexus Authenticator (2-step verification codes, compatible with Google Authenticator). See nexus-authenticator/README.txt.
  - Proton VPN
  All four load automatically each time Nexus starts.
  Activity Monitor still lists "Helium" and "Helium Helper ...": those names are fixed inside the browser itself.

OWN DATA AND OWN KEYCHAIN
  Nexus keeps its data in  ~/Library/Application Support/Nexus  and its own Keychain entry "Nexus Safe Storage",
  separate from Helium. Helium and Nexus can now run side by side. Your Helium bookmarks are copied over once;
  saved passwords and sign-ins are not (they are locked with Helium's key), so sign in again in Nexus.
  Rebuilding the app changes its signature, so macOS may ask for Keychain access again: choose Always Allow.
  To go back to sharing Helium's data you would need a build without this patch; ask for it.

DEFAULT WALLPAPER
  A new Nexus profile starts with the aurora wallpaper (assets/default_background.jpg) on the new tab page.
  Change it any time: pencil button on the new tab page > upload your own. Swap the file in assets/ to change the default.

UPDATING LATER
  - New Helium: put the new helium_*arm64-macos.dmg in base/ and build again.
  - New Proton VPN: ./build_nexus_dmg.sh --refresh-proton
  - nexus_patch.py lists the Helium image ids it changes (ROLE_IDS / RES_LOGOS); if a Helium update moves them, the build stops with a clear message.

IF SOMETHING GOES WRONG
  - Start Nexus without the built-in extensions:   NEXUS_NO_BUILTIN=1 /Applications/Nexus.app/Contents/MacOS/Nexus
  - install_proton_vpn.command is the old Web Store route for Proton VPN. Only needed if the build could not fetch the extension.

FILES
  build_nexus_dmg.sh   the build            nexus_patch.py     renames Helium to Nexus
  nexus_builtin.py     bakes in the extensions and the launcher       nexus_pak.py   pak reader/writer
  nexus-chat/          the AI side panel    nexus-vault/       password manager      assets/   icons
  nexus-authenticator/ 2-step codes (TOTP)
  base/                the Helium base      vendor/            Proton VPN download
