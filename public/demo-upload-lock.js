(() => {
  'use strict';

  const message = 'File uploads are disabled in demo mode.';

  function fileInputFromTrigger(trigger) {
    const inlineHandler = String(trigger?.getAttribute?.('onclick') || '');
    const match = inlineHandler.match(/(?:document\.)?getElementById\(\s*['"]([^'"]+)['"]\s*\)\.click\(\s*\)|\$\(\s*['"]([^'"]+)['"]\s*\)\.click\(\s*\)/);
    const inputId = match?.[1] || match?.[2] || '';
    const input = inputId ? document.getElementById(inputId) : null;
    return input?.matches?.('input[type="file"]') ? input : null;
  }

  function eachMatch(root, selector, callback) {
    if (root?.matches?.(selector)) callback(root);
    root?.querySelectorAll?.(selector).forEach(callback);
  }

  function disableFileUploads(root = document) {
    eachMatch(root, 'input[type="file"]', input => {
      input.disabled = true;
      input.value = '';
      input.setAttribute('aria-disabled', 'true');
      input.setAttribute('title', message);
    });

    eachMatch(root, '[onclick]', trigger => {
      if (!fileInputFromTrigger(trigger)) return;
      trigger.disabled = true;
      trigger.dataset.demoFileUploadTrigger = 'true';
      trigger.setAttribute('aria-disabled', 'true');
      trigger.setAttribute('title', message);
    });
  }

  document.documentElement.setAttribute('data-demo-file-uploads', 'disabled');

  const style = document.createElement('style');
  style.textContent = 'html[data-demo-file-uploads="disabled"] [data-demo-file-upload-trigger="true"]{opacity:.5!important;cursor:not-allowed!important}';
  document.head.appendChild(style);

  document.addEventListener('click', event => {
    const target = event.target?.closest?.('input[type="file"],[onclick]');
    if (!target) return;
    if (!target.matches('input[type="file"]') && !fileInputFromTrigger(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener('change', event => {
    if (!event.target?.matches?.('input[type="file"]')) return;
    event.target.value = '';
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => disableFileUploads(), { once: true });
  } else {
    disableFileUploads();
  }

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) disableFileUploads(node);
      }));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.omnisightDemoFileUploadLock = Object.freeze({
    message,
    apply: disableFileUploads,
  });
})();
