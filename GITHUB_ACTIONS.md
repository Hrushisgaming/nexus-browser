# Building Nexus.dmg on GitHub Actions (arm64, no Mac needed for the compile)

Not run yet: I can't run GitHub Actions from here. If a run fails, send me the log of the failed step.

## Set up (once)
1. Create a new **public** GitHub repo (public repos get free runner minutes; the GPL asks you to share the source of what you distribute anyway).
2. Push THIS folder (the one that contains `.github/`, `helium-macos/` and `nexus-rebrand/`) as the repo root:
   ```
   cd Nexus-Helium-Source
   git init -b main
   git add -A && git commit -m "Nexus source"
   git remote add origin https://github.com/YOU/REPO.git
   git push -u origin main
   ```
   `.github/` must be at the top of the repo, otherwise GitHub does not see the workflow.

## Run
1. Repo > **Actions** > **Build Nexus for macOS (arm64)** > **Run workflow**.
2. Wait. The first job downloads Chromium, applies the patches, stages Nexus Vault + Nexus Authenticator + Proton VPN, and checks they are there.
   Then the compile runs in chained jobs (each stops before GitHub's 6-hour limit, saves its progress, the next one resumes), up to 10.
3. When the last job is green, open the run page > **Artifacts** > **Nexus-arm64-dmg**. Unzip it to get `nexus_<version>_arm64-macos.dmg`.

## Apply a patch from the browser (no git on your Mac)
Workflow: `.github/workflows/apply-patch.yml` ("Apply patch and build Nexus"). Create it once: Add file > Create new file, name it
`.github/workflows/apply-patch.yml`, paste the contents, commit.

Then, for every patch (a `.patch` file from `git format-patch` or `git diff --binary`):
1. Add file > Upload files, drop the `.patch` file at the top of the repo (or into `incoming-patches/`), commit to `main`.
2. The workflow applies it, commits the result to `main`, deletes the `.patch` file and starts "Build Nexus for macOS (arm64)".
   If the patch was uploaded before the workflow existed, run it by hand: Actions > Apply patch and build Nexus > Run workflow.
3. When the build run is green, download the DMG from its Artifacts.

Limits: a patch that does not apply is refused and nothing changes (the log says why). A patch that edits files in `.github/workflows/`
is refused too, because GitHub's built-in token cannot change workflow files; edit those in the web editor. If `main` is protected, the
push fails; use a branch or relax the rule.

## What it is
- arm64 only, unsigned (ad-hoc signed), no release is published, no secrets are needed.
- The compile produces Nexus directly (the source is already rebranded), so `nexus-rebrand/build_nexus_dmg.sh` is NOT run in CI
  (it expects a stock `Helium.app`). Instead the last job runs `nexus_builtin.py --native` on the compiled `Nexus.app` before signing:
  it adds Chat with Nexus and a small launcher that starts the real browser (renamed `NexusBrowser`) with that extension loaded.
  Vault, Authenticator and Proton VPN are compiled in. This launcher step has only been tested on a fake app bundle, not on a real build.
- First launch on your Mac: right-click the app > Open (it is not notarized).

## If it fails
- "No space left on device": the free runner is too small. Tell me; it needs cleanup steps or a larger paid runner.
- Out of monthly minutes: check the Actions usage page of the repo owner.
- A C++ compile error: send me the first error lines. The Nexus patches have never been compiled.
