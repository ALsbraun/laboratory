/* global browser, chrome */

(() => {
  const runtime = typeof browser === 'undefined' ? chrome.runtime : browser.runtime;
  const sentScriptHashes = new Set();
  const sentStyleHashes = new Set();
  const recordedText = new WeakMap();
  let contextActive = true;
  let observer;
  const javascriptTypes = new Set([
    '',
    'application/ecmascript',
    'application/javascript',
    'importmap',
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
    document.removeEventListener('securitypolicyviolation', handleCspViolation, true);
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

  const inlineSelector = 'script:not([src]), style';
  const recordHashes = async roots => {
    if (!contextActive) { return; }
    const scripts = new Set();
    const styles = new Set();
    const elements = new Set();
    roots.forEach(root => {
      if (root.matches?.(inlineSelector)) { elements.add(root); }
      root.querySelectorAll(inlineSelector).forEach(element => elements.add(element));
    });
    elements.forEach(element => {
      const isStyle = element.matches('style');
      if (!isStyle && !javascriptTypes.has((element.type || '').trim().toLowerCase())) { return; }
      const value = element.textContent;
      if (!value || recordedText.get(element) === value) { return; }
      recordedText.set(element, value);
      (isStyle ? styles : scripts).add(value);
    });

    if (scripts.size === 0 && styles.size === 0) { return; }
    const [scriptHashes, styleElementHashes] = await Promise.all([
      Promise.all([...scripts].map(sha256)),
      Promise.all([...styles].map(sha256)),
    ]);
    const hashes = [...new Set(scriptHashes)]
      .filter(hash => !sentScriptHashes.has(hash));
    const styleHashes = [...new Set(styleElementHashes)]
      .filter(hash => !sentStyleHashes.has(hash));
    if (hashes.length === 0 && styleHashes.length === 0) { return; }
    hashes.forEach(hash => sentScriptHashes.add(hash));
    styleHashes.forEach(hash => sentStyleHashes.add(hash));
    await sendMessage({
      type: 'laboratory:inline-element-hashes',
      documentUrl: location.href,
      hashes,
      styleHashes,
    });
  };

  const startRecording = async () => {
    const recording = await sendMessage({
      type: 'laboratory:is-recording',
      documentUrl: location.href,
    });
    if (!recording) { return; }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        recordHashes([document]).catch(console.error);
      }, { once: true });
    }

    observer = new MutationObserver(mutations => {
      const roots = new Set();
      mutations.forEach(mutation => {
        const target = mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target;
        if (target?.matches?.(inlineSelector)) { roots.add(target); }
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) { roots.add(node); }
        });
      });
      recordHashes(roots).catch(console.error);
    });
    observer.observe(document, {
      attributes: true,
      attributeFilter: ['src', 'type'],
      characterData: true,
      childList: true,
      subtree: true,
    });
    await recordHashes([document]);
  };

  function handleCspViolation(event) {
    const directive = event.effectiveDirective || event.violatedDirective;
    if (!event.isTrusted || event.disposition !== 'report' || event.blockedURI === 'inline') { return; }
    sendMessage({
      type: 'laboratory:csp-violation',
      documentUrl: location.href,
      directive,
      blockedUri: event.blockedURI,
      originalPolicy: event.originalPolicy,
    }).catch(console.error);
  }

  document.addEventListener('securitypolicyviolation', handleCspViolation, true);

  startRecording().catch(console.error);
})();
