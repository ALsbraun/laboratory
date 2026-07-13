/* global browser, chrome */

(() => {
  const runtime = typeof browser === 'undefined' ? chrome.runtime : browser.runtime;
  const sentScriptHashes = new Set();
  const sentStyleHashes = new Set();
  let sentScriptUnsafeHashes = false;
  let sentStyleUnsafeHashes = false;
  let sentStrictDynamic = false;
  let hasParserInsertedExternalScripts = false;
  let contextActive = true;
  let observer;
  const javascriptTypes = new Set([
    '',
    'application/ecmascript',
    'application/javascript',
    'module',
    'text/ecmascript',
    'text/javascript',
  ]);

  const sha256 = async value => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const binary = String.fromCharCode(...new Uint8Array(digest));
    return btoa(binary);
  };

  const stopRecording = () => {
    contextActive = false;
    if (observer) { observer.disconnect(); }
    document.removeEventListener('securitypolicyviolation', handleCspViolation);
  };

  const sendMessage = async message => {
    if (!contextActive) { return undefined; }
    try {
      return await runtime.sendMessage(message);
    } catch (error) {
      if (/extension context invalidated/i.test(error && error.message ? error.message : String(error))) {
        stopRecording();
        return undefined;
      }
      throw error;
    }
  };

  const collectHashInputs = root => {
    const scripts = [];
    const handlers = [];
    const styles = [];
    const styleAttributes = [];
    const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [root];

    elements.forEach(element => {
      if (element.matches && element.matches('script:not([src])')
          && javascriptTypes.has((element.type || '').toLowerCase())
          && element.textContent) {
        scripts.push(element.textContent);
      }

      if (element.matches && element.matches('style') && element.textContent) {
        styles.push(element.textContent);
      }

      if (!element.attributes) { return; }
      Array.from(element.attributes).forEach(attribute => {
        if (attribute.name.toLowerCase().startsWith('on') && attribute.value) {
          handlers.push(attribute.value);
        } else if (attribute.name.toLowerCase() === 'style' && attribute.value) {
          styleAttributes.push(attribute.value);
        }
      });
    });

    return { scripts, handlers, styles, styleAttributes };
  };

  const recordHashes = async (root, dynamicallyAdded = false) => {
    if (!contextActive) { return; }
    const { scripts, handlers, styles, styleAttributes } = collectHashInputs(root);
    const scriptHashes = await Promise.all(scripts.map(sha256));
    const handlerHashes = await Promise.all(handlers.map(sha256));
    const styleElementHashes = await Promise.all(styles.map(sha256));
    const styleAttributeHashes = await Promise.all(styleAttributes.map(sha256));
    const hashes = [...new Set([...scriptHashes, ...handlerHashes])]
      .filter(hash => !sentScriptHashes.has(hash));
    const styleHashes = [...new Set([...styleElementHashes, ...styleAttributeHashes])]
      .filter(hash => !sentStyleHashes.has(hash));
    const includesEventHandlers = handlerHashes.length > 0 && !sentScriptUnsafeHashes;
    const includesStyleAttributes = styleAttributeHashes.length > 0 && !sentStyleUnsafeHashes;
    const includesDynamicScripts = dynamicallyAdded && !sentStrictDynamic
      && ((root.matches && root.matches('script[src]'))
        || (root.querySelector && root.querySelector('script[src]')) !== null);

    if (hashes.length === 0 && styleHashes.length === 0
        && !includesEventHandlers && !includesStyleAttributes && !includesDynamicScripts) { return; }
    hashes.forEach(hash => sentScriptHashes.add(hash));
    styleHashes.forEach(hash => sentStyleHashes.add(hash));
    sentScriptUnsafeHashes = sentScriptUnsafeHashes || includesEventHandlers;
    sentStyleUnsafeHashes = sentStyleUnsafeHashes || includesStyleAttributes;
    sentStrictDynamic = sentStrictDynamic || includesDynamicScripts;
    await sendMessage({
      type: 'laboratory:inline-script-hashes',
      documentUrl: location.href,
      hashes,
      styleHashes,
      hasParserInsertedExternalScripts,
      includesDynamicScripts,
      includesEventHandlers,
      includesStyleAttributes,
    });
  };

  const startRecording = async () => {
    const recording = await sendMessage({
      type: 'laboratory:is-recording',
      documentUrl: location.href,
    });
    if (!recording) { return; }

    await recordHashes(document);
    const captureScriptTopology = () => {
      hasParserInsertedExternalScripts = Array.from(document.scripts)
        .some(script => script.src !== '');
      sendMessage({
        type: 'laboratory:script-topology',
        documentUrl: location.href,
        hasParserInsertedExternalScripts,
      }).catch(console.error);
      recordHashes(document).catch(console.error);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', captureScriptTopology, { once: true });
    } else {
      captureScriptTopology();
    }

    observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'attributes') {
          recordHashes(mutation.target).catch(console.error);
        }
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            recordHashes(node, document.readyState !== 'loading').catch(console.error);
          } else if (node.parentElement
              && node.parentElement.matches('script:not([src]), style')) {
            recordHashes(node.parentElement).catch(console.error);
          }
        });
      });
    });
    observer.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  };

  function handleCspViolation(event) {
    sendMessage({
      type: 'laboratory:csp-violation',
      documentUrl: location.href,
      directive: event.effectiveDirective || event.violatedDirective,
      blockedUri: event.blockedURI,
    }).catch(console.error);
  }

  document.addEventListener('securitypolicyviolation', handleCspViolation);

  startRecording().catch(console.error);
})();
