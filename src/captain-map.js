/**
 * "SE Captain mapping" admin modal (maintainer-only).
 *
 * Its own row in the More > Admin flyout (src/overlay.js gates it on the signed
 * is_admin claim). Edits the public.app_settings `se_captain_map` row — the
 * manager -> SE Captain mapping the poc-captain / poc-request-submit edge
 * functions read to tag the right captain on a POC request (see
 * supabase/functions/_shared/seCaptain.ts).
 *
 * The map is keyed by the manager's Salesforce user id. Each row pairs a manager
 * with a captain, both chosen via a typeahead backed by the sfdc-search-users
 * edge function (cb:sfdc:searchUsers). Replaces the raw-JSON textarea that used
 * to live in the Secret configuration modal.
 *
 * Reuses the cb-export-modal / cb-gtme-* / cb-modal-* styles from
 * styles/export.css; the cb-capmap-* classes are this modal's own.
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  let modalEl = null;
  let backdropEl = null;
  let openPanel = null; // the floating picker results panel, if any

  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function closePanel() {
    if (openPanel) { openPanel.remove(); openPanel = null; }
  }
  // Shared with other modals (request-poc.js): close / probe the floating
  // results panel from outside this module.
  __cb.closeSfdcPickerPanel = closePanel;
  __cb.sfdcPickerPanelOpen = () => !!openPanel;

  function close() {
    closePanel();
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    document.removeEventListener("keydown", onKeydown, true);
  }
  __cb.closeCaptainMap = close;

  function onKeydown(evt) {
    if (evt.key !== "Escape") return;
    // A picker dropdown traps Escape first; only then does Escape close the modal.
    if (openPanel) { evt.stopPropagation(); closePanel(); return; }
    evt.stopPropagation();
    close();
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function buildAvatar(name) {
    const av = document.createElement("span");
    av.className = "cb-capmap-avatar";
    av.textContent = initials(name);
    return av;
  }

  // A name typeahead over active SFDC users. The results panel floats on <body>
  // (positioned with __cb.placePopover) so it never clips inside the scrolling
  // modal body. Calls onPick({ id, name, email, role }) on selection.
  // Shared as __cb.buildSfdcUserPicker — also powers the Request POC modal's
  // SE Captain picker. Only one results panel is open at a time across callers.
  function buildUserPicker({ placeholder, onPick }) {
    const wrap = document.createElement("div");
    wrap.className = "cb-capmap-picker";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-gtme-input cb-capmap-picker-input";
    input.placeholder = placeholder || "Search by name\u2026";
    input.autocomplete = "off";
    input.spellcheck = false;
    wrap.appendChild(input);

    let debounceTimer = null;
    let lastReqId = 0;

    function renderPanel(records, statusText) {
      closePanel();
      const panel = document.createElement("div");
      panel.className = "cb-capmap-picker-panel";
      openPanel = panel;
      if (statusText) {
        const s = document.createElement("div");
        s.className = "cb-capmap-picker-status";
        s.textContent = statusText;
        panel.appendChild(s);
      } else if (!records.length) {
        const s = document.createElement("div");
        s.className = "cb-capmap-picker-status";
        s.textContent = "No matches.";
        panel.appendChild(s);
      } else {
        for (const r of records) {
          const opt = document.createElement("button");
          opt.type = "button";
          opt.className = "cb-capmap-picker-opt";
          const av = buildAvatar(r.name);
          const text = document.createElement("span");
          text.className = "cb-capmap-picker-opt-text";
          const nm = document.createElement("span");
          nm.className = "cb-capmap-picker-opt-name";
          nm.textContent = r.name;
          const sub = document.createElement("span");
          sub.className = "cb-capmap-picker-opt-sub";
          sub.textContent = [r.role, r.email].filter(Boolean).join(" \u00b7 ");
          text.appendChild(nm);
          text.appendChild(sub);
          opt.appendChild(av);
          opt.appendChild(text);
          opt.addEventListener("mousedown", (e) => {
            // mousedown (not click) so it fires before the input blur closes us.
            e.preventDefault();
            e.stopPropagation();
            closePanel();
            input.value = "";
            if (typeof onPick === "function") onPick(r);
          });
          panel.appendChild(opt);
        }
      }
      document.body.appendChild(panel);
      panel.style.width = `${Math.max(input.offsetWidth, 240)}px`;
      if (__cb.placePopover) __cb.placePopover(panel, input, { gap: 4 });
    }

    async function run(q) {
      const reqId = ++lastReqId;
      renderPanel([], "Searching\u2026");
      const resp = await sendMessage({ type: "cb:sfdc:searchUsers", q });
      if (reqId !== lastReqId) return; // superseded by a newer keystroke
      const records = resp && resp.ok && resp.data && Array.isArray(resp.data.records)
        ? resp.data.records
        : [];
      if (!resp || !resp.ok) {
        renderPanel([], "Couldn\u2019t search Salesforce.");
        return;
      }
      renderPanel(records, null);
    }

    input.addEventListener("input", () => {
      const q = input.value.trim();
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      if (q.length < 2) { closePanel(); return; }
      debounceTimer = setTimeout(() => run(q), 250);
    });
    input.addEventListener("blur", () => {
      // Delay so a result's mousedown can fire before we tear the panel down.
      setTimeout(() => { if (openPanel && openPanel.previousSibling !== input) closePanel(); }, 120);
    });

    return { el: wrap, focus: () => input.focus() };
  }
  __cb.buildSfdcUserPicker = buildUserPicker;

  // ---- Modal -------------------------------------------------------------

  __cb.openCaptainMap = function openCaptainMap() {
    close();

    // Working state: an array of { managerId, managerName, captainName,
    // captainEmail }. Rows missing a manager or captain are drafts (edit mode);
    // they're dropped on save.
    let rows = [];

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-export-modal-backdrop";
    backdropEl.addEventListener("mousedown", (evt) => {
      if (evt.target === backdropEl) close();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-gtme-modal cb-capmap-modal";
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    // Header
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "SE Captain mapping";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent =
      "On a POC request, the captain for the requester\u2019s manager is tagged in Slack.";
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

    // Body
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";

    const intro = document.createElement("div");
    intro.className = "cb-capmap-intro";
    intro.innerHTML =
      "Each row maps a <strong>manager</strong> to the <strong>SE Captain</strong> tagged for their reports. " +
      "A requester whose manager isn\u2019t listed gets no captain.";
    body.appendChild(intro);

    const listEl = document.createElement("div");
    listEl.className = "cb-capmap-list";
    body.appendChild(listEl);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cb-capmap-add";
    addBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
      "<span>Add mapping</span>";
    addBtn.addEventListener("click", () => {
      closePanel();
      rows.push({ managerId: null, managerName: null, captainName: null, captainEmail: null });
      renderList(true);
    });
    body.appendChild(addBtn);

    const errorEl = document.createElement("div");
    errorEl.className = "cb-gtme-error";
    errorEl.style.display = "none";
    body.appendChild(errorEl);
    function showError(msg) { errorEl.textContent = msg; errorEl.style.display = ""; }
    function clearError() { errorEl.textContent = ""; errorEl.style.display = "none"; }

    // Renders one mapping row. Manager is the key (read-only once set; remove +
    // re-add to change it). Captain is editable via "Change".
    function renderRow(row, idx) {
      const rowEl = document.createElement("div");
      rowEl.className = "cb-capmap-row";

      // Manager side
      const mgrSide = document.createElement("div");
      mgrSide.className = "cb-capmap-side";
      if (row.managerId) {
        const person = document.createElement("div");
        person.className = "cb-capmap-person";
        person.appendChild(buildAvatar(row.managerName));
        const text = document.createElement("div");
        text.className = "cb-capmap-person-text";
        const nm = document.createElement("div");
        nm.className = "cb-capmap-name";
        nm.textContent = row.managerName || row.managerId;
        const sub = document.createElement("div");
        sub.className = "cb-capmap-sub";
        sub.textContent = "Manager";
        text.appendChild(nm);
        text.appendChild(sub);
        person.appendChild(text);
        mgrSide.appendChild(person);
      } else {
        const picker = buildUserPicker({
          placeholder: "Search manager\u2026",
          onPick: (rec) => { row.managerId = rec.id; row.managerName = rec.name; renderList(false); },
        });
        mgrSide.appendChild(picker.el);
        setTimeout(() => picker.focus(), 0);
      }
      rowEl.appendChild(mgrSide);

      const arrow = document.createElement("div");
      arrow.className = "cb-capmap-arrow";
      arrow.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
      rowEl.appendChild(arrow);

      // Captain side
      const capSide = document.createElement("div");
      capSide.className = "cb-capmap-side";
      if (row.captainName) {
        const person = document.createElement("div");
        person.className = "cb-capmap-person";
        person.appendChild(buildAvatar(row.captainName));
        const text = document.createElement("div");
        text.className = "cb-capmap-person-text";
        const nm = document.createElement("div");
        nm.className = "cb-capmap-name";
        nm.textContent = row.captainName;
        const sub = document.createElement("div");
        sub.className = "cb-capmap-sub";
        sub.textContent = row.captainEmail || "SE Captain";
        text.appendChild(nm);
        text.appendChild(sub);
        person.appendChild(text);
        const change = document.createElement("button");
        change.type = "button";
        change.className = "cb-capmap-change";
        change.textContent = "Change";
        change.addEventListener("click", () => {
          row.captainName = null; row.captainEmail = null; renderList(false);
        });
        person.appendChild(change);
        capSide.appendChild(person);
      } else {
        const picker = buildUserPicker({
          placeholder: "Search SE Captain\u2026",
          onPick: (rec) => {
            row.captainName = rec.name; row.captainEmail = rec.email || null; renderList(false);
          },
        });
        capSide.appendChild(picker.el);
        if (row.managerId) setTimeout(() => picker.focus(), 0);
      }
      rowEl.appendChild(capSide);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "cb-capmap-remove";
      remove.setAttribute("aria-label", "Remove mapping");
      remove.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.addEventListener("click", () => { rows.splice(idx, 1); renderList(false); });
      rowEl.appendChild(remove);

      return rowEl;
    }

    function renderList(focusLast) {
      closePanel();
      listEl.innerHTML = "";
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "cb-capmap-empty";
        empty.textContent = "No mappings yet. Add one to start tagging SE Captains.";
        listEl.appendChild(empty);
        return;
      }
      rows.forEach((row, idx) => listEl.appendChild(renderRow(row, idx)));
      if (focusLast) {
        const lastInput = listEl.querySelector(".cb-capmap-row:last-child .cb-capmap-picker-input");
        if (lastInput) lastInput.focus();
      }
    }

    // Footer
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
      if (!supa) { showError("Supabase client not ready."); return; }
      clearError();
      // Serialize complete rows; keyed by manager id (last wins on duplicates).
      const map = {};
      for (const r of rows) {
        if (!r.managerId || !r.captainName) continue;
        map[r.managerId] = {
          managerName: r.managerName || null,
          captainName: r.captainName,
          captainEmail: r.captainEmail || null,
        };
      }
      saveBtn.disabled = true;
      saveBtn.style.opacity = ".5";
      saveBtn.textContent = "Saving\u2026";
      try {
        await supa.supabaseFetch("app_settings", "POST", {
          prefer: "resolution=merge-duplicates",
          body: {
            key: "se_captain_map",
            value: JSON.stringify(map),
            updated_by: __cb.userId || null,
            updated_at: new Date().toISOString(),
          },
        });
        saveBtn.textContent = "Saved \u2713";
        setTimeout(() => { close(); }, 800);
      } catch (err) {
        showError(`Save failed: ${err?.message || err}`);
        saveBtn.textContent = "Save";
        saveBtn.disabled = false;
        saveBtn.style.opacity = "1";
      }
    }

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    // Capture phase so the picker dropdown can trap Escape before the modal.
    document.addEventListener("keydown", onKeydown, true);

    // Load the existing mapping.
    listEl.textContent = "Loading\u2026";
    listEl.className = "cb-capmap-list cb-capmap-loading";
    (async () => {
      const supa = window.__cbSupabase;
      listEl.className = "cb-capmap-list";
      if (!supa) { showError("Supabase client not ready."); renderList(false); return; }
      try {
        const data = await supa.supabaseFetch("app_settings", "GET", {
          query: { select: "value", key: "eq.se_captain_map", limit: "1" },
        });
        const raw = (data?.[0]?.value ?? "").trim();
        const obj = raw ? JSON.parse(raw) : {};
        rows = Object.entries(obj).map(([managerId, v]) => ({
          managerId,
          managerName: (v && v.managerName) || null,
          captainName: (v && v.captainName) || null,
          captainEmail: (v && v.captainEmail) || null,
        }));
      } catch (err) {
        showError(`Could not load the mapping: ${err?.message || err}`);
        rows = [];
      }
      renderList(false);
    })();
  };
})();
