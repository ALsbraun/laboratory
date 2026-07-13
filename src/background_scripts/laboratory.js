import * as browser from 'webextension-polyfill';
import localForage from 'localforage';
import { defaultState, unmonitorableSites } from './static';
import { extractHostname } from './utils';

const RECORDING_POLICY = 'default-src \'none\'; form-action \'none\'; connect-src \'none\'; font-src \'none\'; frame-src \'none\'; img-src \'none\'; manifest-src \'none\'; media-src \'none\'; object-src \'none\'; prefetch-src \'none\'; script-src \'none\'; style-src \'none\'; worker-src \'none\'';

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Lab {
  constructor() {
    this.state = undefined;
    this.ready = this.initialize();
  }


  async initialize() {
    this.state = await this.getLocalState();
    await this.writeLocalState();
    await this.syncNetworkRules();
  }


  // get the list of all monitored sites in one way or another
  getActiveHosts() {
    const hosts = new Set([].concat(
          this.state.config.customcspHosts,
          this.state.config.enforcedHosts,
          this.state.config.recordingHosts,
    ));

    return hosts;
  }


  siteTemplate() {
    const site = {};
    Object.keys(defaultState().config.strictness).map(x => {
      site[x] = [];  // TODO: convert to Set once localforage supports it
      return undefined;
    });

    return site;
  }


  async syncNetworkRules() {
    const oldRules = await browser.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = oldRules.map(rule => rule.id);
    const hosts = [...this.getActiveHosts()].sort();
    const addRules = hosts.map((host, index) => {
      let header = 'content-security-policy-report-only';
      let policy = RECORDING_POLICY;

      if (this.state.config.customcspHosts.includes(host)) {
        header = 'content-security-policy';
        policy = this.state.config.customcspRecords[host] || 'default-src \'none\'';
      } else if (this.state.config.enforcedHosts.includes(host)) {
        header = 'content-security-policy';
        policy = this.buildCsp(host).text;
      }

      const otherHeader = header === 'content-security-policy'
        ? 'content-security-policy-report-only'
        : 'content-security-policy';

      return {
        id: index + 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: otherHeader, operation: 'remove' },
            { header, operation: 'set', value: policy },
          ],
        },
        condition: {
          regexFilter: `^https?://${escapeRegex(host)}/`,
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      };
    });

    await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }


  async clearState() {
    console.log('Laboratory: Clearing all local storage');
    this.state = defaultState();
    await this.writeLocalState();
    await this.syncNetworkRules();
  }


  async getLocalState() {
    const stored = await browser.storage.local.get('state');
    let state = stored.state;
    if (state === undefined) {
      try {
        state = await localForage.getItem('state');
      } catch (error) {
        console.warn('Laboratory: Could not migrate legacy state', error);
      }
    }
    if (state === undefined || state === null) {
      state = defaultState();
    }

    // let's loop through state and make sure everything is there
    Object.entries(defaultState()).forEach(([key, value]) => {
      if (!(key in state)) {
        state[key] = value;
      }

      // and loop through subkeys as well -- maybe this could use recursion
      // eventually; or we could just not nest any deeper than this
      if (typeof value === 'object') {
        Object.entries(value).forEach(([subkey, subvalue]) => {
          if (!(subkey in state[key])) {
            state[key][subkey] = subvalue;
          }
        });
      }
    });

    return state;
  }


  writeLocalState() {
    return browser.storage.local.set({ state: this.state });
  }


  buildCsp(host) {
    let uri;
    let cspHtml = '<strong>default-src</strong> \'none\';';
    let cspText = 'default-src \'none\';';
    let directive;
    let path;
    let sources;

    // build the CSP based on the strictness settings set
    const strictness = this.state.config.strictness;

    // first, we need to construct a shadow CSP that contains directives by strictness
    const shadowCSP = this.siteTemplate();

    // get the record for our host
    const records = this.state.records;

    // a handful of sites are completely immune to extensions that do the sort of thing we're doing
    if (unmonitorableSites.includes(host)) {
      return {
        html: '😭  Security controls prevent monitoring  😭',
        text: '😭  Security controls prevent monitoring  😭',
        records: shadowCSP,
      };
    }

    // if it's a host we don't have records for, let's just return default-src 'none'
    if (!(host in records)) {
      return {
        html: cspHtml.slice(0, -1),
        text: cspText.slice(0, -1),
        records: shadowCSP,
      };
    }

    Object.entries(records[host]).forEach(entry => {
      directive = entry[0];
      sources = entry[1];

      // now we need to iterate over each source and munge it
      sources.forEach(source => {
        let mungedSource;

        // Never weaken a generated policy with broad inline-code or eval permissions.
        if (source === '\'unsafe-inline\'' || source === '\'unsafe-eval\'') { return; }

        // if it's a special case, we don't do processing - ws: and wss: are Firefox bugs
        if (['\'unsafe-hashes\'', '\'strict-dynamic\'', 'data:', 'ws:', 'wss:'].includes(source)
            || /^'sha(256|384|512)-[A-Za-z0-9+/]+={0,2}'$/.test(source)) {
          mungedSource = source;
        } else {
          uri = new URL(source);

          // the source is simply the origin if there is no path
          if (uri.pathname === '/' && strictness[directive] !== 'scheme') {
            mungedSource = uri.origin;
          }
          else {
            switch (strictness[directive]) {
              case 'none':
                mungedSource = '\'none\'';
                break;
              case 'scheme':
                mungedSource = uri.protocol;
                break;
              case 'origin':
                if (uri.host === host) {
                  mungedSource = '\'self\'';
                } else {
                  mungedSource = uri.origin;
                }
                break;
              case 'self-if-same-origin-else-directory':
                if (uri.host === host) {
                  mungedSource = '\'self\'';
                  break;
                }
                // falls through
              case 'directory':
                path = uri.pathname.split('/');
                path.pop();
                mungedSource = `${uri.origin}${path.join('/')}/`;
                break;
              case 'self-if-same-origin-else-path':
                if (uri.host === host) {
                  mungedSource = '\'self\'';
                  break;
                }
                // falls through
              case 'path':
                mungedSource = uri.href;
                break;
              default:
                break;
            }
          }
        }

        // now we simply add the entry to the shadowCSP, if it's not already there
        if (!shadowCSP[directive].includes(mungedSource)) {
          shadowCSP[directive].push(mungedSource);
        }
      });
    });


    // compile together a new CSP policy
    Object.keys(shadowCSP).sort().forEach(key => {
      directive = key;
      sources = shadowCSP[directive].sort();

      if (sources.length > 0) {
        cspHtml = `${cspHtml} <br />&nbsp;&nbsp;<strong>${directive}</strong> ${sources.join(' ')};`;
        cspText = `${cspText} ${directive} ${sources.join(' ')};`;
      }
    });

    // return our resolved CSP without the trailing semicolon
    // also return the shadow CSP if needed
    return {
      html: cspHtml.slice(0, -1),
      text: cspText.slice(0, -1),
      records: shadowCSP,
    };
  }

  ingestCspViolation(message) {
    const records = this.state.records;
    const directive = message.directive.split(' ')[0].replace('-attr', '').replace('-elem', '');
    const host = extractHostname(message.documentUrl);
    let uri = message.blockedUri;

    if (!this.state.config.recordingHosts.includes(host) || !(directive in this.siteTemplate())) {
      return;
    }

    // sometimes when things inject into the DOM, the blocked uri returns weird values
    // lets simply return if that's the case
    if (!uri && uri !== '') {
      return false;
    }

    // catch the special cases (data, unsafe)
    switch (uri) {
      case 'self':
      case 'inline':
      case '':
        // Inline scripts and styles are captured by the content script as CSP hashes.
        return;
      case 'eval':
        // There is no secure CSP source expression that permits string evaluation.
        return;
      case 'data':
        uri = 'data:';
        break;
      case 'ws':  // currently broken, see: https://bugzilla.mozilla.org/show_bug.cgi?id=1505178
        uri = 'ws:';
        break;
      case 'wss': // also broken
        uri = 'wss:';
        break;
      default:
        uri = new URL(uri);
        uri = uri.pathname === '/' ? uri.origin : uri.origin + uri.pathname;
        break;
    }

    // add the host to the records, if it's not already there
    if (!(host in records)) {
      records[host] = this.siteTemplate();
    }

    // add the uri to the resources for that directive
    // don't record if we're currently enforcing or have a custom CSP
    if (!records[host][directive].includes(uri)
      && !this.state.config.customcspHosts.includes(host)
      && !this.state.config.enforcedHosts.includes(host)) {
      records[host][directive].push(uri);
    }

    return undefined;
  }


  ingestInlineScriptHashes(message) {
    const host = extractHostname(message.documentUrl);
    const records = this.state.records;

    if (!this.state.config.recordingHosts.includes(host)
        || this.state.config.customcspHosts.includes(host)
        || this.state.config.enforcedHosts.includes(host)) {
      return;
    }

    if (!(host in records)) {
      records[host] = this.siteTemplate();
    }

    const sources = records[host]['script-src'];
    const unsafeInlineIndex = sources.indexOf('\'unsafe-inline\'');
    if (unsafeInlineIndex !== -1) {
      sources.splice(unsafeInlineIndex, 1);
    }

    message.hashes
      .filter(hash => /^[A-Za-z0-9+/]+={0,2}$/.test(hash))
      .map(hash => `'sha256-${hash}'`)
      .forEach(source => {
        if (!sources.includes(source)) { sources.push(source); }
      });

    if (message.includesEventHandlers && !sources.includes('\'unsafe-hashes\'')) {
      sources.push('\'unsafe-hashes\'');
    }

    const styleSources = records[host]['style-src'];
    const unsafeStyleInlineIndex = styleSources.indexOf('\'unsafe-inline\'');
    if (unsafeStyleInlineIndex !== -1) {
      styleSources.splice(unsafeStyleInlineIndex, 1);
    }

    (message.styleHashes || [])
      .filter(hash => /^[A-Za-z0-9+/]+={0,2}$/.test(hash))
      .map(hash => `'sha256-${hash}'`)
      .forEach(source => {
        if (!styleSources.includes(source)) { styleSources.push(source); }
      });

    // CSP requires unsafe-hashes for hashed style attributes. Unlike unsafe-inline,
    // this permits only the exact recorded attribute values.
    if (message.includesStyleAttributes && !styleSources.includes('\'unsafe-hashes\'')) {
      styleSources.push('\'unsafe-hashes\'');
    }

    if (message.hasParserInsertedExternalScripts) {
      const strictDynamicIndex = sources.indexOf('\'strict-dynamic\'');
      if (strictDynamicIndex !== -1) { sources.splice(strictDynamicIndex, 1); }
    } else if (message.includesDynamicScripts && !sources.includes('\'strict-dynamic\'')) {
      sources.push('\'strict-dynamic\'');
    }
  }


  ingestScriptTopology(message) {
    const host = extractHostname(message.documentUrl);
    const site = this.state.records[host];
    if (!site || !message.hasParserInsertedExternalScripts) { return; }
    const sources = site['script-src'];
    const index = sources.indexOf('\'strict-dynamic\'');
    if (index !== -1) { sources.splice(index, 1); }
  }


  getModel(host) {
    const custom = this.state.config.customcspHosts.includes(host);
    const builtCsp = custom
      ? {
        records: {},
        html: this.state.config.customcspRecords[host] || 'default-src \'none\'',
        text: this.state.config.customcspRecords[host] || 'default-src \'none\'',
      }
      : this.buildCsp(host);
    return { state: this.state, builtCsp };
  }


  async toggle(host, toggleId, enabled) {
    const record = this.state.config[`${toggleId}Hosts`];
    if (!record || !host) { return this.getModel(host); }

    const index = record.indexOf(host);
    if (enabled && index === -1) {
      record.push(host);
    } else if (!enabled && index !== -1) {
      record.splice(index, 1);
    }

    await this.writeLocalState();
    await this.syncNetworkRules();
    return this.getModel(host);
  }


  async updateCustomCsp(host, text) {
    const hosts = this.state.config.customcspHosts;
    const index = hosts.indexOf(host);
    if (text === '') {
      if (index !== -1) { hosts.splice(index, 1); }
      delete this.state.config.customcspRecords[host];
    } else {
      if (index === -1) { hosts.push(host); }
      this.state.config.customcspRecords[host] = text;
    }
    await this.writeLocalState();
    await this.syncNetworkRules();
    return this.getModel(host);
  }


  async updateStrictness(host, strictness) {
    this.state.config.strictness = Object.assign(this.state.config.strictness, strictness);
    await this.writeLocalState();
    await this.syncNetworkRules();
    return this.getModel(host);
  }
}


console.log('Laboratory: Initializing');
const lab = new Lab();
browser.runtime.onMessage.addListener(async message => {
  await lab.ready;
  if (!message || typeof message.type !== 'string') { return undefined; }

  if (message.type === 'laboratory:inline-script-hashes'
      && Array.isArray(message.hashes)
      && (message.styleHashes === undefined || Array.isArray(message.styleHashes))
      && typeof message.documentUrl === 'string') {
    lab.ingestInlineScriptHashes(message);
    await lab.writeLocalState();
    return undefined;
  }
  if (message.type === 'laboratory:csp-violation'
      && typeof message.documentUrl === 'string'
      && typeof message.directive === 'string'
      && typeof message.blockedUri === 'string') {
    lab.ingestCspViolation(message);
    await lab.writeLocalState();
    return undefined;
  }
  if (message.type === 'laboratory:script-topology'
      && typeof message.documentUrl === 'string') {
    lab.ingestScriptTopology(message);
    await lab.writeLocalState();
    return undefined;
  }
  if (message.type === 'laboratory:get-model') {
    return lab.getModel(message.host || '');
  }
  if (message.type === 'laboratory:is-recording') {
    try {
      const host = extractHostname(message.documentUrl || '');
      return lab.state.config.recordingHosts.includes(host)
        && !lab.state.config.customcspHosts.includes(host)
        && !lab.state.config.enforcedHosts.includes(host);
    } catch (error) {
      return false;
    }
  }
  if (message.type === 'laboratory:toggle') {
    return lab.toggle(message.host || '', message.toggleId, Boolean(message.enabled));
  }
  if (message.type === 'laboratory:update-custom-csp') {
    return lab.updateCustomCsp(message.host || '', message.text || '');
  }
  if (message.type === 'laboratory:update-strictness') {
    return lab.updateStrictness(message.host || '', message.strictness || {});
  }
  if (message.type === 'laboratory:clear-state') {
    await lab.clearState();
    return lab.getModel(message.host || '');
  }
  return undefined;
});

browser.runtime.onInstalled.addListener(() => lab.ready.then(() => lab.syncNetworkRules()));
browser.runtime.onStartup.addListener(() => lab.ready.then(() => lab.syncNetworkRules()));
