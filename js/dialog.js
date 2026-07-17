/*
 * dialog.js — small reusable modal for the custom-preset save/overwrite/
 * delete flows (main.js), used instead of native prompt()/confirm() so the
 * save flow can show an inline "overwrite?" step without stacking a second
 * popup. One overlay/panel pair is built lazily and reused; open()
 * re-populates it. Closes on Escape, backdrop click, or Cancel; traps Tab
 * focus inside the panel and restores focus to whatever was focused before
 * open() when it closes.
 */
window.Dialog = (function () {
  'use strict';

  var overlay, panel, titleEl, bodyEl, confirmBtn, cancelBtn;
  var activeOnConfirm = null;
  var lastFocused = null;

  function focusables() {
    return panel.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])');
  }

  function onKeydown(e) {
    if (overlay.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      var f = focusables();
      if (f.length === 0) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName === 'INPUT') {
      e.preventDefault();
      if (activeOnConfirm) activeOnConfirm();
    }
  }

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.hidden = true;

    panel = document.createElement('div');
    panel.className = 'dialog-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    titleEl = document.createElement('h3');
    titleEl.className = 'dialog-title';

    bodyEl = document.createElement('div');
    bodyEl.className = 'dialog-body';

    var actions = document.createElement('div');
    actions.className = 'dialog-actions';
    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'dialog-cancel';
    cancelBtn.textContent = 'Cancel';
    confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'dialog-confirm';
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    panel.appendChild(titleEl);
    panel.appendChild(bodyEl);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    cancelBtn.addEventListener('click', close);
    confirmBtn.addEventListener('click', function () {
      if (activeOnConfirm) activeOnConfirm();
    });
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    bodyEl.innerHTML = '';
    activeOnConfirm = null;
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  /*
   * opts: { title, bodyNodes: Node|Node[], confirmLabel, onConfirm, focusEl }
   * onConfirm does NOT auto-close — call Dialog.close() or Dialog.update()
   * from inside it (the inline "overwrite?" step replaces the body via
   * update() instead of closing, so it reads as one continuous dialog).
   */
  function update(opts) {
    ensureDom();
    titleEl.textContent = opts.title;
    bodyEl.innerHTML = '';
    var nodes = Array.isArray(opts.bodyNodes) ? opts.bodyNodes : [opts.bodyNodes];
    nodes.forEach(function (n) { if (n) bodyEl.appendChild(n); });
    confirmBtn.textContent = opts.confirmLabel;
    activeOnConfirm = opts.onConfirm;
    var toFocus = opts.focusEl || confirmBtn;
    setTimeout(function () {
      toFocus.focus();
      if (typeof toFocus.select === 'function') toFocus.select();
    }, 0);
  }

  function open(opts) {
    ensureDom();
    lastFocused = document.activeElement;
    update(opts);
    overlay.hidden = false;
  }

  return { open: open, update: update, close: close };
})();
