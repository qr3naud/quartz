/**
 * Admin settings modal (maintainer-only).
 *
 * Opened from the "Admin" row in the More menu, which src/overlay.js gates on
 * the signed `is_admin` JWT claim (__cb.isAdmin) — the same flag as the Archived
 * submenu. Reads and writes the public.app_settings key/value table directly via
 * supabaseFetch.
 *
 * Writes are additionally enforced server-side by RLS (cb_caller_is_admin()):
 * only an admin's JWT can INSERT/UPDATE app_settings, so this modal is a
 * convenience UI, not the security boundary. Today it edits
 * `poc_request_channel` (the Slack channel poc-request-submit posts to); new
 * settings rows show up automatically. Below the editable settings, a read-only
 * "Feature flags & gating" panel lists the two gating tiers (internal feature
 * flags + maintainer-only surfaces) with a live status badge for the current
 * session.
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
      hint: "Pick a channel the bot is in — stored as the channel ID.",
      slack: true,
    },
    deal_desk_channel: {
      label: "Deal desk Slack channel",
      hint: "Pick a channel the bot is in. Leave unset to use the server default.",
      slack: true,
    },
  };

  // Fetch the Slack channels the bot is a member of via the slack-channels Edge
  // Function (proxied by the service worker). Resolves to an array of
  // { id, name }, or false on any failure so the UI can fall back to a text box.
  function fetchSlackChannels() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "cb:slack:channels" }, (resp) => {
          if (chrome.runtime.lastError) { resolve(false); return; }
          const chs = resp?.data?.channels;
          resolve(resp?.ok && resp.data?.ok && Array.isArray(chs) ? chs : false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  // Read-only reference rendered in the "Feature flags & gating" panel below the
  // editable settings. Two tiers:
  //   - INTERNAL_FEATURES: gated to internal @clay.com users via the JWT
  //     `features` claim (clay-auth-mint INTERNAL_FEATURES). Live status comes
  //     from __cb.hasFeature(); derived from Clay workspace membership, so it's
  //     informational, not toggleable from here.
  //   - MAINTAINER_SURFACES: gated to the maintainer via the signed `is_admin`
  //     claim (__cb.isAdmin), set by clay-auth-mint from the ADMIN_EMAILS secret.
  // Labels/hints only — no emails or secrets live in this bundle.
  const INTERNAL_FEATURES = [
    { flag: "internal_branding", label: "Internal branding", hint: '"Quartz" name + internal UI instead of "Scoping".' },
    { flag: "gtme_export",       label: "GTME export",        hint: "Export to GTME Calculator, Request POC, deal-desk / DealOps rows." },
    { flag: "pricing_comparison", label: "Pricing comparison", hint: "Old vs New Pricing comparison modal." },
    { flag: "sfdc",              label: "Salesforce",         hint: "Link and search SFDC opportunities." },
    { flag: "dust",              label: "Dust",               hint: "Dust AI POC integration." },
  ];

  const MAINTAINER_SURFACES = [
    { label: "Secret configuration", hint: "Edits app_settings (e.g. Slack channels)." },
    { label: "Submit to deal desk", hint: "Owner-only row in the Export menu." },
    { label: "Export as Table",     hint: "Owner-only row in the Export menu." },
    { label: "Canvas view",         hint: "The Cards / Tables toggle in the More menu." },
    { label: "Version picker",      hint: "Install / roll back to any version in the update modal." },
    { label: "Archived submenu",    hint: "Deprecated toggles in the More menu." },
  ];

  // One status row: label (+ optional code chip), hint, and an on/off badge.
  function buildFlagRow(opts) {
    const row = document.createElement("div");
    row.className = "cb-ff-row";

    const text = document.createElement("div");
    text.className = "cb-ff-row-text";

    const labelEl = document.createElement("div");
    labelEl.className = "cb-ff-row-label";
    labelEl.appendChild(document.createTextNode(opts.label));
    if (opts.code) {
      const codeEl = document.createElement("code");
      codeEl.className = "cb-ff-code";
      codeEl.textContent = opts.code;
      labelEl.appendChild(codeEl);
    }
    text.appendChild(labelEl);

    if (opts.hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "cb-ff-row-hint";
      hintEl.textContent = opts.hint;
      text.appendChild(hintEl);
    }

    const badge = document.createElement("span");
    badge.className = "cb-ff-badge " + (opts.on ? "cb-ff-badge-on" : "cb-ff-badge-off");
    badge.textContent = opts.on ? opts.onText : opts.offText;

    row.appendChild(text);
    row.appendChild(badge);
    return row;
  }

  // Builds the read-only "Feature flags & gating" panel. Reads __cb live; the
  // modal is only reachable once the JWT (and __cb.isAdmin / features) resolved,
  // so a synchronous render reflects the current session accurately.
  function buildGatingSection() {
    const section = document.createElement("div");
    section.className = "cb-ff-section";

    const heading = document.createElement("div");
    heading.className = "cb-ff-heading";
    heading.textContent = "Feature flags & gating";
    section.appendChild(heading);

    const intro = document.createElement("div");
    intro.className = "cb-ff-intro";
    intro.textContent =
      "Read-only, live for your current session. Admin is set via the ADMIN_EMAILS Supabase secret (signed into your JWT); internal flags come from your Clay workspace membership.";
    section.appendChild(intro);

    const internalLabel = document.createElement("div");
    internalLabel.className = "cb-ff-group-label";
    internalLabel.textContent = "Gated internally (@clay.com)";
    section.appendChild(internalLabel);
    for (const f of INTERNAL_FEATURES) {
      const on = !!(__cb.hasFeature && __cb.hasFeature(f.flag));
      section.appendChild(
        buildFlagRow({ label: f.label, code: f.flag, hint: f.hint, on, onText: "Active", offText: "Off" }),
      );
    }

    const adminLabel = document.createElement("div");
    adminLabel.className = "cb-ff-group-label";
    adminLabel.textContent = "Gated to me (admin)";
    section.appendChild(adminLabel);
    const isAdmin = !!__cb.isAdmin;
    for (const s of MAINTAINER_SURFACES) {
      section.appendChild(
        buildFlagRow({ label: s.label, hint: s.hint, on: isAdmin, onText: "You", offText: "Locked" }),
      );
    }

    return section;
  }

  function close() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    document.removeEventListener("keydown", onKeydown);
  }
  __cb.closeAdminSettings = close;

  function onKeydown(evt) {
    if (evt.key === "Escape") { evt.stopPropagation(); close(); }
  }

  // view: "secrets" (editable app_settings — Slack channels) or "flags"
  // (read-only feature-flag & gating reference). The two share this modal shell
  // but render different bodies/footers so each admin tool is its own surface.
  function openAdminModal(view) {
    close();
    const isFlags = view === "flags";

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
    title.textContent = isFlags ? "Feature flags & gating" : "Secret configuration";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = isFlags
      ? "Read-only reference, live for your current session. Maintainer-only."
      : "Operational config stored in Supabase (app_settings). Maintainer-only.";
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

    // Feature Flags view: just the read-only gating reference. Secret config
    // view: the editable app_settings form (Slack channels, etc.).
    let fieldsWrap = null;
    let errorEl = null;
    if (isFlags) {
      body.appendChild(buildGatingSection());
    } else {
      fieldsWrap = document.createElement("div");
      // Two clean columns: each setting (label + input + hint) is a grid cell.
      fieldsWrap.style.cssText =
        "display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:16px 20px;align-items:start;";
      fieldsWrap.textContent = "Loading…";
      fieldsWrap.style.opacity = ".7";
      body.appendChild(fieldsWrap);

      errorEl = document.createElement("div");
      errorEl.className = "cb-gtme-error";
      errorEl.style.display = "none";
      body.appendChild(errorEl);
    }

    function showError(msg) { if (errorEl) { errorEl.textContent = msg; errorEl.style.display = ""; } }
    function clearError() { if (errorEl) { errorEl.textContent = ""; errorEl.style.display = "none"; } }

    // key -> { getValue, initial }
    const editors = new Map();

    // Slack channel dropdown state. null = still loading, false = fetch failed
    // (fall back to a text field), or an array of { id, name }. Fetched in
    // parallel with the app_settings load; when it resolves we rebuild the
    // channel controls in place via the registered rebuilders.
    let slackChannels = null;
    const slackControlRebuilders = new Map();

    function makeTextInput(value, hint) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cb-gtme-input";
      input.autocomplete = "off";
      input.value = value || "";
      if (hint) input.placeholder = hint;
      return input;
    }

    // Renders the channel control inside `container` from the current
    // slackChannels state: loading -> disabled select; failed -> text input;
    // loaded -> a <select> of the bot's channels (value = ID, label = #name)
    // plus a "Custom…" escape hatch that swaps to a text input. Keeps
    // editor.getValue pointed at whichever control is live.
    function buildSlackControl(container, key, value, editor) {
      container.innerHTML = "";
      const hint = (KNOWN[key] || {}).hint;

      if (slackChannels === null) {
        const sel = document.createElement("select");
        sel.className = "cb-gtme-input";
        sel.disabled = true;
        const opt = document.createElement("option");
        opt.textContent = "Loading channels…";
        sel.appendChild(opt);
        container.appendChild(sel);
        editor.getValue = () => value;
        return;
      }

      if (slackChannels === false) {
        const input = makeTextInput(value, hint);
        container.appendChild(input);
        editor.getValue = () => input.value;
        return;
      }

      const sel = document.createElement("select");
      sel.className = "cb-gtme-input";
      if (!value) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "Select a channel…";
        sel.appendChild(o);
      } else if (!slackChannels.some((c) => c.id === value)) {
        // Preserve an existing value (e.g. an ID the bot isn't a member of) so
        // it stays selected and isn't silently dropped on save.
        const o = document.createElement("option");
        o.value = value;
        o.textContent = `Current: ${value}`;
        sel.appendChild(o);
      }
      for (const c of slackChannels) {
        const o = document.createElement("option");
        o.value = c.id;
        o.textContent = `#${c.name}`;
        sel.appendChild(o);
      }
      const customOpt = document.createElement("option");
      customOpt.value = "__custom__";
      customOpt.textContent = "Custom…";
      sel.appendChild(customOpt);
      sel.value = value || "";
      sel.addEventListener("change", () => {
        if (sel.value === "__custom__") {
          container.innerHTML = "";
          const input = makeTextInput(value, hint);
          container.appendChild(input);
          input.focus();
          editor.getValue = () => input.value;
        }
      });
      container.appendChild(sel);
      editor.getValue = () => sel.value;
    }

    function renderRows(rows) {
      fieldsWrap.innerHTML = "";
      fieldsWrap.style.opacity = "1";
      slackControlRebuilders.clear();
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
        const label = document.createElement("span");
        label.className = "cb-gtme-field-label";
        label.textContent = meta.label || key;
        field.appendChild(label);

        const editor = { getValue: () => value, initial: value };
        editors.set(key, editor);

        if (meta.slack) {
          // Channel picker. A wrapper div lets us swap the control in place
          // (loading -> select / text) once the channel list resolves.
          const control = document.createElement("div");
          field.appendChild(control);
          const rebuild = () => buildSlackControl(control, key, value, editor);
          slackControlRebuilders.set(key, rebuild);
          rebuild();
        } else {
          const input = makeTextInput(value, meta.hint);
          field.appendChild(input);
          editor.getValue = () => input.value;
        }

        if (meta.hint) {
          const hintEl = document.createElement("div");
          hintEl.className = "cb-gtme-tabs-hint";
          hintEl.style.cssText = "margin-top:4px;";
          hintEl.textContent = meta.hint;
          field.appendChild(hintEl);
        }
        fieldsWrap.appendChild(field);
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
    footerHint.textContent = isFlags
      ? "Read-only reference \u00b7 maintainer only."
      : "Stored in Supabase \u00b7 maintainer only.";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";
    let saveBtn = null;
    if (isFlags) {
      const doneBtn = document.createElement("button");
      doneBtn.type = "button";
      doneBtn.className = "cb-modal-btn cb-modal-btn-primary";
      doneBtn.textContent = "Done";
      doneBtn.addEventListener("click", close);
      footerActions.appendChild(doneBtn);
    } else {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "cb-modal-btn cb-modal-btn-ghost";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", close);
      saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "cb-modal-btn cb-modal-btn-primary";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", onSave);
      footerActions.appendChild(cancelBtn);
      footerActions.appendChild(saveBtn);
    }
    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    async function onSave() {
      const supa = window.__cbSupabase;
      if (!supa) return;
      clearError();
      const changed = [];
      for (const [key, ed] of editors.entries()) {
        const value = ed.getValue().trim();
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

    if (!isFlags) {
      load();
      // Fetch the bot's channels in parallel; rebuild the channel dropdowns in
      // place when they arrive (works whether this resolves before or after the
      // app_settings rows render).
      fetchSlackChannels().then((chs) => {
        slackChannels = Array.isArray(chs) ? chs : false;
        for (const rebuild of slackControlRebuilders.values()) rebuild();
      });
    }
  }

  // Secret configuration — the editable app_settings form (e.g. Slack channels).
  __cb.openSecretConfig = function openSecretConfig() { openAdminModal("secrets"); };
  // Feature flags & gating — the read-only reference panel.
  __cb.openFeatureFlags = function openFeatureFlags() { openAdminModal("flags"); };
  // Back-compat alias for any caller still using the old name.
  __cb.openAdminSettings = __cb.openSecretConfig;
})();
