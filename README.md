Laboratory
==========

Laboratory is a Firefox and Chrome WebExtension that helps you generate a proper Content Security Policy (CSP) header for your website.  Simply start recording, browse your site, and enjoy the CSP header that it produces:

![Preview Image](https://i.imgur.com/Ij1agqQ.png)

Laboratory uses Manifest V3 and requires Chrome 121 or newer, Firefox 140 or newer on desktop, or Firefox 142 or newer on Android.

While recording, Laboratory generates SHA-256 CSP sources for inline scripts, inline styles, and their attributes. It never generates `unsafe-inline` or `unsafe-eval`. For hashed event-handler or style attributes, it may add the narrowly scoped CSP `unsafe-hashes` keyword, which permits only the exact recorded hashes. It adds `strict-dynamic` only when a page with trusted hashes inserts additional scripts dynamically.

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

## Publishing a GitHub Release

Pushing a version tag that matches `package.json` runs the release workflow. For example:

```bash
$ git tag v4.0.0
$ git push origin v4.0.0
```

The workflow builds and validates both variants, then publishes versioned Chrome and Firefox ZIP files plus SHA-256 checksums on the corresponding GitHub Release. It can also be started manually from the Actions page with the matching version tag.

GitHub Release packages are intended for sideloading: unzip the Chrome package and load it from `chrome://extensions` with Developer mode enabled. The Firefox package can be loaded temporarily from `about:debugging`; permanent Firefox installation requires Mozilla signing.
