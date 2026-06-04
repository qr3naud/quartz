/**
 * Admin settings modal (maintainer-only).
 *
 * Opened from the "Admin" row in the More menu, which src/overlay.js gates on
 * the same quentin.renaud@clay.com check as the Archived submenu. Reads and
 * writes the public.app_settings key/value table directly via supabaseFetch.
 *
 * Writes are additionally enforced server-side by RLS (cb_caller_is_admin()):
 * only the maintainer's JWT can INSERT/UPDATE app_settings, so this modal is a
 * convenience UI, not the security boundary. Today it edits
 * `poc_request_channel` (the Slack channel poc-request-submit posts to); new
 * settings rows show up automatically.
 *
 * Reuses the cb-export-modal / cb-gtme-* styles from styles/export.css.
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  let modalEl = null;
  let backdropEl = null;

  // Friendly labels/hints for known keys. Unknown keys still render with their
  // raw key as the label so nothing is hidden.
  const KNOWN = {
    poc_request_channel: {
      label: "POC request Slack channel",
      hint: "Channel ID (e.g. C0AFJMW5Q75) or #name — the bot must be a member.",
    },
    deal_desk_channel: {
      label: "Deal desk Slack channel",
      hint: "Channel name (e.g. #deal-desk) or ID the deal-desk app posts to. Leave blank to use the server default.",
    },
  };

  function close() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    document.removeEventListener("keydown", onKeydown);
  }
  __cb.closeAdminSettings = close;

  function onKeydown(evt) {
    if (evt.key === "Escape") { evt.stopPropagation(); close(); }
  }

  __cb.openAdminSettings = function openAdminSettings() {
    close();

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-export-modal-backdrop";
    backdropEl.addEventListener("mousedown", (evt) => {
      if (evt.target === backdropEl) close();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-gtme-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Admin settings";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Operational config stored in Supabase (app_settings). Maintainer-only.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", close);
    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";

    const fieldsWrap = document.createElement("div");
    fieldsWrap.style.cssText = "display:flex;flex-direction:column;gap:10px;";
    fieldsWrap.textContent = "Loading…";
    fieldsWrap.style.opacity = ".7";
    body.appendChild(fieldsWrap);

    const errorEl = document.createElement("div");
    errorEl.className = "cb-gtme-error";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    function showError(msg) { errorEl.textContent = msg; errorEl.style.display = ""; }
    function clearError() { errorEl.textContent = ""; errorEl.style.display = "none"; }

    // key -> { input, initial }
    const editors = new Map();

    function renderRows(rows) {
      fieldsWrap.innerHTML = "";
      fieldsWrap.style.opacity = "1";
      // Render every known setting (so unset ones still show and can be
      // created), then any extra keys already in the DB we have no metadata for.
      const byKey = new Map();
      for (const r of rows || []) byKey.set(r.key, r.value || "");
      const keys = [
        ...Object.keys(KNOWN),
        ...[...byKey.keys()].filter((k) => !(k in KNOWN)),
      ];
      for (const key of keys) {
        const meta = KNOWN[key] || {};
        const value = byKey.get(key) || "";
        const field = document.createElement("label");
        field.className = "cb-gtme-field cb-gtme-field-grow";
        field.style.display = "block";
        const label = document.createElement("span");
        label.className = "cb-gtme-field-label";
        label.textContent = meta.label || key;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "cb-gtme-input";
        input.autocomplete = "off";
        input.value = value;
        if (meta.hint) input.placeholder = meta.hint;
        field.appendChild(label);
        field.appendChild(input);
        if (meta.hint) {
          const hint = document.createElement("div");
          hint.className = "cb-gtme-tabs-hint";
          hint.style.cssText = "margin-top:4px;";
          hint.textContent = meta.hint;
          field.appendChild(hint);
        }
        fieldsWrap.appendChild(field);
        editors.set(key, { input, initial: value });
      }
    }

    async function load() {
      const supa = window.__cbSupabase;
      if (!supa) { showError("Supabase client not ready."); fieldsWrap.textContent = ""; return; }
      try {
        const rows = await supa.supabaseFetch("app_settings", "GET", {
          query: { select: "key,value,updated_at,updated_by", order: "key.asc" },
        });
        renderRows(rows || []);
      } catch (err) {
        fieldsWrap.textContent = "";
        showError(`Could not load settings: ${err?.message || err}`);
      }
    }

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent = "Stored in Supabase \u00b7 maintainer only.";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "cb-modal-btn cb-modal-btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", onSave);
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(saveBtn);
    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    async function onSave() {
      const supa = window.__cbSupabase;
      if (!supa) return;
      clearError();
      const changed = [];
      for (const [key, ed] of editors.entries()) {
        const value = ed.input.value.trim();
        if (value !== ed.initial) changed.push({ key, value });
      }
      if (!changed.length) { saveBtn.textContent = "Saved ✓"; setTimeout(() => { saveBtn.textContent = "Save"; }, 1500); return; }

      saveBtn.disabled = true;
      saveBtn.style.opacity = ".5";
      saveBtn.textContent = "Saving…";
      const nowIso = new Date().toISOString();
      try {
        for (const c of changed) {
          await supa.supabaseFetch("app_settings", "POST", {
            prefer: "resolution=merge-duplicates",
            body: { key: c.key, value: c.value, updated_by: __cb.userId || null, updated_at: nowIso },
          });
        }
        for (const c of changed) {
          const ed = editors.get(c.key);
          if (ed) ed.initial = c.value;
        }
        saveBtn.textContent = "Saved ✓";
        setTimeout(() => { saveBtn.textContent = "Save"; }, 1800);
      } catch (err) {
        showError(`Save failed: ${err?.message || err}`);
        saveBtn.textContent = "Save";
      } finally {
        saveBtn.disabled = false;
        saveBtn.style.opacity = "1";
      }
    }

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    document.addEventListener("keydown", onKeydown);

    load();
  };
})();
