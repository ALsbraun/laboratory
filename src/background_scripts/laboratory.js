import * as browser from 'webextension-polyfill';
import localForage from 'localforage';
import { defaultState, unmonitorableSites } from './static';
import { extractHostname } from './utils';

const RECORDING_POLICY = "default-src 'none'; form-action 'none'; worker-src 'none'; script-src-attr 'none'; style-src-attr 'none'";
const HASH_SOURCE = /^'sha(256|384|512)-[A-Za-z0-9+/_-]+={0,2}'$/i;
const INLINE_ELEMENT_DIRECTIVES = ['script-src', 'style-src'];
const NONCE_SOURCE = "'nonce-{{CSP_NONCE}}'";
const DEFAULT_SOURCES = {
  'base-uri': "'self'",
  'form-action': "'self'",
  'object-src': "'none'",
  'worker-src': "'none'",
};
const EMBEDDED_RESOURCE_DIRECTIVES = new Set(['font-src', 'img-src', 'media-src']);
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

const normalizePolicy = policy => policy.split(';').map(part => part.trim().replace(/\s+/g, ' '))
  .filter(Boolean).join(';');
const normalizedRecordingPolicy = normalizePolicy(RECORDING_POLICY);

const normalizeResource = (source, directive) => {
  const embeddedScheme = /^(data|blob)(?::|$)/i.exec(source);
  if (embeddedScheme) {
    return EMBEDDED_RESOURCE_DIRECTIVES.has(directive) ? `${embeddedScheme[1].toLowerCase()}:` : undefined;
  }
  const websocketScheme = /^(wss?):?$/i.exec(source);
  if (websocketScheme) {
    return directive === 'connect-src' ? `${websocketScheme[1].toLowerCase()}:` : undefined;
  }
  if (!URL.canParse(source)) { return undefined; }
  const uri = new URL(source);
  if (!NETWORK_PROTOCOLS.has(uri.protocol)) { return undefined; }
  return uri.origin + uri.pathname.replace(/[;,]/g, char => encodeURIComponent(char));
};

const formatSource = (source, directive, strictness, host) => {
  const resource = normalizeResource(source, directive);
  if (!resource || /^(data|blob|wss?):$/.test(resource)) { return resource; }
  const uri = new URL(resource);
  if (strictness === 'scheme') { return uri.protocol; }
  if ((strictness === 'origin' || strictness.startsWith('self-if-same-origin')) && uri.host === host) {
    return "'self'";
  }
  if (strictness === 'origin' || uri.pathname === '/') { return uri.origin; }
  if (strictness.endsWith('directory')) {
    return uri.origin + uri.pathname.slice(0, uri.pathname.lastIndexOf('/') + 1);
  }
  return resource;
};

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

      return {
        id: index + 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: this.state.config.customcspHosts.includes(host)
            ? [
              { header: 'content-security-policy-report-only', operation: 'remove' },
              { header, operation: 'set', value: policy },
            ]
            : [{ header, operation: 'append', value: policy }],
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
    const records = this.siteTemplate();
    if (unmonitorableSites.includes(host)) {
      const message = '😭  Security controls prevent monitoring  😭';
      return { html: message, text: message, records };
    }

    const site = this.state.records[host] || {};
    const defaults = defaultState().config.strictness;
    Object.keys(records).forEach(directive => {
      const strictness = this.state.config.strictness[directive] || defaults[directive];
      const savedSources = site[directive] || [];
      if (strictness === 'none') {
        if (savedSources.length || site[`${directive}-elem`]?.length || DEFAULT_SOURCES[directive]) {
          records[directive] = ["'none'"];
        }
        return;
      }

      // Older recorders kept element and attribute hashes in the same list.
      const mixedHashes = savedSources.some(source => /^'unsafe-hashes'$/i.test(source));
      const sources = new Set();
      savedSources.forEach(source => {
        if (HASH_SOURCE.test(source)) {
          if (!mixedHashes && INLINE_ELEMENT_DIRECTIVES.includes(directive)) { sources.add(source); }
          return;
        }
        const formatted = formatSource(source, directive, strictness, host);
        if (formatted) { sources.add(formatted); }
      });

      if (INLINE_ELEMENT_DIRECTIVES.includes(directive)) {
        (site[`${directive}-elem`] || [])
          .filter(source => HASH_SOURCE.test(source)).forEach(source => sources.add(source));
      }

      // An already-allowed origin covers any explicit path from that origin.
      records[directive] = [...sources].filter(source => {
        if (!URL.canParse(source)) { return true; }
        const uri = new URL(source);
        return uri.origin === source || !sources.has(uri.origin);
      }).sort();
    });

    const policy = { ...records };
    Object.entries(DEFAULT_SOURCES).forEach(([directive, source]) => {
      if (!policy[directive]?.length) { policy[directive] = [source]; }
    });
    const directives = [
      ['default-src', ["'none'"]],
      ...Object.entries(policy).filter(([, sources]) => sources.length > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    ];

    const text = directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
    const html = directives.map(([name, sources]) => `<strong>${name}</strong> ${sources.join(' ')}`)
      .join('; <br />&nbsp;&nbsp;');
    const hasInlineHashes = INLINE_ELEMENT_DIRECTIVES.some(directive =>
      records[directive].some(source => HASH_SOURCE.test(source)));
    const nonceTemplate = hasInlineHashes ? directives.map(([name, sources]) => {
      if (!sources.some(source => HASH_SOURCE.test(source))) { return `${name} ${sources.join(' ')}`; }
      const nonceSources = [...sources.filter(source => !HASH_SOURCE.test(source)), NONCE_SOURCE];
      return `${name} ${nonceSources.join(' ')}`;
    }).join('; ') : undefined;
    return { html, text, nonceTemplate, records };
  }


  ingestCspViolation(message) {
    const { config, records } = this.state;
    if (normalizePolicy(message.originalPolicy) !== normalizedRecordingPolicy) { return false; }
    const directive = message.directive.split(' ')[0].replace(/-elem$/, '');
    const host = extractHostname(message.documentUrl);
    const template = this.siteTemplate();
    if (!config.recordingHosts.includes(host) || config.customcspHosts.includes(host)
        || config.enforcedHosts.includes(host) || !Object.hasOwn(template, directive)) {
      return false;
    }

    const source = normalizeResource(message.blockedUri, directive);
    if (!source) { return false; }
    const site = records[host] ??= template;
    const sources = site[directive] ??= [];
    if (sources.includes(source)) { return false; }
    sources.push(source);
    return true;
  }


  ingestInlineElementHashes(message) {
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

    const site = records[host];
    const elementHashes = {
      'script-src-elem': message.hashes,
      'style-src-elem': message.styleHashes,
    };
    Object.entries(elementHashes).forEach(([key, hashes]) => {
      const sources = site[key] ??= [];
      hashes.filter(hash => typeof hash === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(hash))
        .map(hash => `'sha256-${hash}'`)
        .forEach(source => {
          if (!sources.includes(source)) { sources.push(source); }
        });
    });
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

  if (message.type === 'laboratory:inline-element-hashes'
      && Array.isArray(message.hashes)
      && Array.isArray(message.styleHashes)
      && typeof message.documentUrl === 'string') {
    lab.ingestInlineElementHashes(message);
    await lab.writeLocalState();
    return undefined;
  }
  if (message.type === 'laboratory:csp-violation'
      && typeof message.documentUrl === 'string'
      && typeof message.directive === 'string'
      && typeof message.blockedUri === 'string'
      && typeof message.originalPolicy === 'string') {
    if (lab.ingestCspViolation(message)) { await lab.writeLocalState(); }
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
