Laboratory
==========

Laboratory is a Firefox and Chrome WebExtension that helps you generate a proper Content Security Policy (CSP) header for your website.  Simply start recording, browse your site, and enjoy the CSP header that it produces:

![Preview Image](https://i.imgur.com/Ij1agqQ.png)

Laboratory uses Manifest V3 and requires Chrome 121 or newer, Firefox 140 or newer on desktop, or Firefox 142 or newer on Android.

Laboratory records the sources a site uses, including assets from external CDNs, and uses SHA-256 hashes for observed inline `<script>` and `<style>` elements. New profiles use path-level script and worker sources. Generated policies block inline event handlers, `style` attributes, and string evaluation. The extension preserves the site's CSP when recording and when enforcing a generated policy.

Use **Copy nonce template** when inline blocks change often or the hash list is long. In your server renderer, replace `{{CSP_NONCE}}` with a fresh cryptographically random Base64 value of at least 128 bits on each HTML response. Use that same value in the CSP header and on the trusted inline `<script>` and `<style>` elements rendered by that response. Keep the header and markup in sync through caching, and avoid adding nonces to markup built from untrusted input. Review the recorded sources, form destinations, and `frame-ancestors` requirements, then deploy in report-only mode and exercise the site's flows before enforcing in production.

## Developing and Installing Locally

It is recommended that developers use [web-ext](https://github.com/mozilla/web-ext) for installation and testing. It provides useful features such as automated installation and reloads upon source changes. For testing and development, install Node.js 24.11 or newer, run `npm ci`, and then run the following commands in two separate terminal windows:

For Chrome:

```bash
$ npm run watch:chrome
```

```bash
$ npm run start:chrome
```

For Firefox, use `npm run watch:firefox` and `npm run start:firefox` instead. Chrome and Firefox are built separately because their Manifest V3 background keys differ.

Lastly, for a "production" release, run:

```bash
$ npm install
$ npm run build
$ zip dist/laboratory.src.zip *.md config package* src
```

This creates `dist/laboratory-chrome.zip` and `dist/laboratory-firefox.zip`.

## Automated maintenance and checks

Every pull request builds and validates both browser extensions, reviews dependency
changes for newly introduced vulnerabilities of moderate severity or higher, and
runs CodeQL JavaScript analysis. CI retains the Chrome and Firefox ZIP files as
downloadable artifacts for 14 days. CodeQL also runs on `master` and every Monday.

Renovate manages npm version updates (including major versions) and weekly lockfile
maintenance. Dependabot manages weekly GitHub Actions updates and npm security
fixes, so the bots do not both open routine npm version updates. Dependabot security
updates require the dependency graph, Dependabot alerts, and Dependabot security
updates to be enabled in GitHub's security settings.

Both bots use GitHub native auto-merge with squash merging. Before merging this
configuration, let the checks run on its pull request, then configure the repository:

1. In **Settings → Rules → Rulesets**, add these required checks to the active
   ruleset for `master` (select **GitHub Actions** as their source):
   - `Build and validate extensions`
   - `Review dependency changes`
   - `Analyze JavaScript`
2. Keep **Require branches to be up to date before merging** enabled, and use zero
   required approving reviews for unattended bot merges.
3. In **Settings → General → Pull Requests**, enable **Allow squash merging** and
   **Allow auto-merge**. Optionally enable automatic deletion of merged branches.
4. Ensure Renovate is installed for this repository and GitHub Actions is enabled.
   Use CodeQL's advanced setup for the checked-in workflow rather than also
   enabling default setup.

The Dependabot workflow checks that all three required checks are configured before
enabling auto-merge. It uses the base branch workflow and never executes PR code with
write permissions. Renovate's native auto-merge also depends on the required-check
ruleset; do not leave its required-check list empty. New or updated dependency PRs
will merge once these checks pass. Existing Dependabot PRs can be rebased to trigger
the new automation after this configuration lands.

## Publishing a GitHub Release

Pushing a version tag that matches `package.json` runs the release workflow. For example:

```bash
$ git tag v4.0.0
$ git push origin v4.0.0
```

The workflow builds and validates both variants, then publishes versioned Chrome and Firefox ZIP files plus SHA-256 checksums on the corresponding GitHub Release. It can also be started manually from the Actions page with the matching version tag.

GitHub Release packages are intended for sideloading: unzip the Chrome package and load it from `chrome://extensions` with Developer mode enabled. The Firefox package can be loaded temporarily from `about:debugging`; permanent Firefox installation requires Mozilla signing.
