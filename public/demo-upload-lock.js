(() => {
  'use strict';

  const fileUploadMessage = 'File uploads are disabled in demo mode.';
  const usersMessage = 'User and role management is read-only in demo mode.';

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
      input.setAttribute('title', fileUploadMessage);
    });

    eachMatch(root, '[onclick]', trigger => {
      if (!fileInputFromTrigger(trigger)) return;
      trigger.disabled = true;
      trigger.dataset.demoFileUploadTrigger = 'true';
      trigger.setAttribute('aria-disabled', 'true');
      trigger.setAttribute('title', fileUploadMessage);
    });
  }

  function disableUsersAndRoles(root = document) {
    eachMatch(root, '.settings-nav-btn[data-target="users"]', button => {
      button.disabled = false;
      button.dataset.demoUsersReadOnly = 'true';
      button.removeAttribute?.('aria-disabled');
      button.setAttribute('title', usersMessage);
    });

    eachMatch(root, '#card-users', card => {
      card.dataset.demoUsersReadOnly = 'true';
      card.setAttribute('aria-readonly', 'true');
      card.setAttribute('title', usersMessage);
      card.querySelectorAll('input,select,textarea,button').forEach(control => {
        control.disabled = true;
        control.setAttribute('aria-disabled', 'true');
        control.setAttribute('title', usersMessage);
      });
    });

    if (root !== document && root?.closest?.('#card-users')) {
      eachMatch(root, 'input,select,textarea,button', control => {
        control.disabled = true;
        control.setAttribute('aria-disabled', 'true');
        control.setAttribute('title', usersMessage);
      });
    }
  }

  function applyDemoLocks(root = document) {
    disableFileUploads(root);
    disableUsersAndRoles(root);
  }

  document.documentElement.setAttribute('data-demo-file-uploads', 'disabled');
  document.documentElement.setAttribute('data-demo-users-roles', 'read-only');

  const style = document.createElement('style');
  style.textContent = [
    'html[data-demo-file-uploads="disabled"] [data-demo-file-upload-trigger="true"]{opacity:.5!important;cursor:not-allowed!important}',
    'html[data-demo-users-roles="read-only"] #card-users input:disabled,html[data-demo-users-roles="read-only"] #card-users select:disabled,html[data-demo-users-roles="read-only"] #card-users textarea:disabled,html[data-demo-users-roles="read-only"] #card-users button:disabled{cursor:not-allowed!important}',
  ].join('');
  document.head.appendChild(style);

  document.addEventListener('click', event => {
    if (event.target?.closest?.('#card-users input,#card-users select,#card-users textarea,#card-users button')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = event.target?.closest?.('input[type="file"],[onclick]');
    if (!target) return;
    if (!target.matches('input[type="file"]') && !fileInputFromTrigger(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener('change', event => {
    if (event.target?.closest?.('#card-users')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.target?.matches?.('input[type="file"]')) return;
    event.target.value = '';
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyDemoLocks(), { once: true });
  } else {
    applyDemoLocks();
  }

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) applyDemoLocks(node);
      }));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.omnisightDemoFileUploadLock = Object.freeze({
    message: fileUploadMessage,
    apply: disableFileUploads,
    usersMessage,
    applyUsersAndRoles: disableUsersAndRoles,
    applyAll: applyDemoLocks,
  });
})();
