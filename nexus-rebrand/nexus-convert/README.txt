CONVERT WITH NEXUS - "Convert to it!" built into Nexus (type  nexus://convert )

What it is: the open-source file converter github.com/p2r3/convert (GPL-2.0). Everything runs on your computer; files are not uploaded.

This folder holds only the wrapper (manifest.json, nexus-redirect.js, icons). The converter itself is built from its
source by   nexus-rebrand/fetch_convert.sh   (needs bun). Until you run that, there is no index.html here and
nexus://convert has nothing to open; the build skips this extension then.

After fetch_convert.sh: rebuild Nexus (build_nexus_dmg.sh, or the GitHub Actions build, which runs the script itself).
Not tested yet: the extension rules (no remote scripts, WebAssembly allowed, cross-origin isolation) were written from the
converter's own settings. If a conversion tool does nothing, open nexus://extensions, press "Inspect views" for
"Convert with Nexus" and send me the console errors.

Prebuilt copy: the GitHub workflow "Build Convert with Nexus" (.github/workflows/build-convert.yml) runs fetch_convert.sh on
GitHub and commits the result into this folder. Run it once from the Actions tab, then pull; build_nexus_dmg.sh will then
include nexus://convert without you having bun.
