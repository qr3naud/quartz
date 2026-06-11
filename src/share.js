/*
 * Share dialog: publish the current tab's scoping view as a public,
 * token-slugged link served by the share-view Edge Function.
 *
 * Entry point: "Share scope link" row in the export menu (src/export.js),
 * gated behind the `share_links` feature flag + maintainer (`__cb.isAdmin`)
 * while the surface is iterated on.
 *
 * Publish flow: snapshot the table view (__cb.tableView.getExportData(), used
 * only as AI context — the public page always re-reads live canvas_tabs.state)
 * and send it with the publisher's options to share-publish via the service
 * worker (message "cb:share:call"). The function calls Claude for the
 * narrative template, mints the slug, and returns the public URL. The dialog
 * also lists this workbook's active links with revoke buttons.
 *
 * IMPORTANT: the link is fully live — edits to the scoping tab are instantly
 * visible to anyone holding the link. The dialog says so under the Generate
 * button.
 *
 * Reuses the cb-export-modal shell styles from styles/export.css; share-only
 * bits live in styles/share.css.
 */
(function () {
  "use strict";

  const __cb = window.__cb;

  let backdropEl = null;
  let modalEl = null;

  const MODULES = [
    { id: "exec_summary", label: "Executive summary", checked: true },
    { id: "scope_table", label: "Scope table", checked: true },
    { id: "use_cases", label: "Use case breakdown", checked: true },
    { id: "coverage_highlights", label: "Coverage highlights", checked: false },
    { id: "next_steps", label: "Next steps", checked: true },
  ];

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
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  }

  function currentWorkbookId() {
    return __cb.currentWorkbookId || __cb.parseIdsFromUrl?.()?.workbookId || "";
  }

  function activeTabId() {
    const store = __cb.tabStore;
    return store && store.activeId ? store.activeId : "";
  }

  function close() {
    // modalEl lives inside backdropEl (the fixed flex-centering layer), so
    // removing the backdrop removes both.
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    modalEl = null;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString();
  }

  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = old; }, 1500);
    } catch {
      // Clipboard can be denied in some frames; select-able input remains.
    }
  }

  __cb.openShareDialog = function openShareDialog() {
    close();

    const workbookId = currentWorkbookId();
    const tabId = activeTabId();
    if (!workbookId || !tabId) return;

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-export-modal-backdrop";
    backdropEl.addEventListener("mousedown", (evt) => {
      if (evt.target === backdropEl) close();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-share-modal";

    // Header
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const title = document.createElement("div");
    title.className = "cb-export-modal-title";
    title.textContent = "Share scope link";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);
    header.appendChild(title);
    header.appendChild(closeBtn);
    modalEl.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-share-body";
    modalEl.appendChild(body);

    function field(labelText, inputEl) {
      const wrap = document.createElement("label");
      wrap.className = "cb-share-field";
      const lab = document.createElement("span");
      lab.className = "cb-share-field-label";
      lab.textContent = labelText;
      wrap.appendChild(lab);
      wrap.appendChild(inputEl);
      return wrap;
    }

    const customerInput = document.createElement("input");
    customerInput.type = "text";
    customerInput.className = "cb-gtme-input";
    customerInput.placeholder = "Acme Corp";
    body.appendChild(field("Customer / account name (used in the link + page title)", customerInput));

    // Module checkboxes
    const modWrap = document.createElement("div");
    modWrap.className = "cb-share-modules";
    const modChecks = new Map();
    for (const mod of MODULES) {
      const lab = document.createElement("label");
      lab.className = "cb-share-module";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = mod.checked;
      modChecks.set(mod.id, cb);
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" " + mod.label));
      modWrap.appendChild(lab);
    }
    body.appendChild(field("Sections to include", modWrap));

    // Credits toggle (off by default — don't expose credits unless chosen)
    const creditsLab = document.createElement("label");
    creditsLab.className = "cb-share-module cb-share-credits";
    const creditsCb = document.createElement("input");
    creditsCb.type = "checkbox";
    creditsCb.checked = false;
    creditsLab.appendChild(creditsCb);
    creditsLab.appendChild(
      document.createTextNode(" Include credit amounts on the page"),
    );
    body.appendChild(creditsLab);

    const contextInput = document.createElement("input");
    contextInput.type = "text";
    contextInput.className = "cb-gtme-input";
    contextInput.placeholder =
      "e.g. technical eval audience, emphasize coverage over cost";
    body.appendChild(field("Audience / context note for the narrative (optional)", contextInput));

    // Generate row + result
    const genRow = document.createElement("div");
    genRow.className = "cb-share-generate-row";
    const genBtn = document.createElement("button");
    genBtn.type = "button";
    genBtn.className = "cb-export-modal-done cb-share-generate";
    genBtn.textContent = "Generate link";
    genRow.appendChild(genBtn);
    const genHint = document.createElement("div");
    genHint.className = "cb-share-hint";
    genHint.textContent =
      "The page reads live data — edits to this tab are instantly visible to anyone with the link. Links expire after 30 days.";
    body.appendChild(genRow);
    body.appendChild(genHint);

    const resultWrap = document.createElement("div");
    resultWrap.className = "cb-share-result";
    resultWrap.style.display = "none";
    body.appendChild(resultWrap);

    const errEl = document.createElement("div");
    errEl.className = "cb-share-error";
    errEl.style.display = "none";
    body.appendChild(errEl);

    // Active links list
    const listTitle = document.createElement("div");
    listTitle.className = "cb-share-list-title";
    listTitle.textContent = "Active links for this workbook";
    body.appendChild(listTitle);
    const listEl = document.createElement("div");
    listEl.className = "cb-share-list";
    listEl.textContent = "Loading…";
    body.appendChild(listEl);

    function showError(msg) {
      errEl.textContent = msg;
      errEl.style.display = "";
    }

    function showResult(data) {
      resultWrap.style.display = "";
      resultWrap.innerHTML = "";

      const linkRow = document.createElement("div");
      linkRow.className = "cb-share-result-link";
      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.className = "cb-gtme-input cb-share-url";
      urlInput.readOnly = true;
      urlInput.value = data.url;
      urlInput.addEventListener("focus", () => urlInput.select());
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "cb-export-modal-done cb-share-copy";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => copyToClipboard(data.url, copyBtn));
      linkRow.appendChild(urlInput);
      linkRow.appendChild(copyBtn);
      resultWrap.appendChild(linkRow);

      // AI narrative status + preview, so a silent fallback is never mistaken
      // for a generated narrative. Full template also goes to the console.
      const status = document.createElement("div");
      status.className =
        "cb-share-ai-status" + (data.aiGenerated ? "" : " cb-share-ai-fallback");
      status.textContent = data.aiGenerated
        ? "AI narrative generated ✓"
        : `AI narrative failed — page uses default sections without prose${data.aiError ? ` (${data.aiError})` : ""}`;
      resultWrap.appendChild(status);

      const modules = (data.template && data.template.modules) || [];
      const prosed = modules.filter((m) => m.prose || m.useCaseProse);
      if (prosed.length) {
        const preview = document.createElement("details");
        preview.className = "cb-share-ai-preview";
        const summary = document.createElement("summary");
        summary.textContent = "Preview generated narrative";
        preview.appendChild(summary);
        for (const m of prosed) {
          const block = document.createElement("div");
          block.className = "cb-share-ai-preview-block";
          const h = document.createElement("strong");
          h.textContent = m.type;
          block.appendChild(h);
          if (m.prose) {
            const p = document.createElement("p");
            p.textContent = m.prose;
            block.appendChild(p);
          }
          for (const [uc, prose] of Object.entries(m.useCaseProse || {})) {
            const p = document.createElement("p");
            p.textContent = `${uc}: ${prose}`;
            block.appendChild(p);
          }
          preview.appendChild(block);
        }
        resultWrap.appendChild(preview);
      }
      console.log("[cb-share] published link", {
        url: data.url,
        aiGenerated: data.aiGenerated,
        aiError: data.aiError || null,
        template: data.template,
      });
    }

    async function refreshList() {
      const resp = await sendMessage({
        type: "cb:share:call",
        body: { action: "list", workbookId },
      });
      if (!modalEl) return; // dialog closed while loading
      listEl.innerHTML = "";
      const links =
        resp && resp.ok && resp.data && Array.isArray(resp.data.links)
          ? resp.data.links.filter((l) => !l.revokedAt)
          : null;
      if (!links) {
        listEl.textContent = "Couldn't load links.";
        return;
      }
      if (!links.length) {
        listEl.textContent = "No active links yet.";
        return;
      }
      for (const link of links) {
        const row = document.createElement("div");
        row.className = "cb-share-list-row";
        const a = document.createElement("a");
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = link.slug;
        a.className = "cb-share-list-slug";
        const meta = document.createElement("span");
        meta.className = "cb-share-list-meta";
        meta.textContent = `expires ${fmtDate(link.expiresAt)}`;
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "cb-share-list-btn";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", () => copyToClipboard(link.url, copyBtn));
        const revokeBtn = document.createElement("button");
        revokeBtn.type = "button";
        revokeBtn.className = "cb-share-list-btn cb-share-list-revoke";
        revokeBtn.textContent = "Revoke";
        revokeBtn.addEventListener("click", async () => {
          revokeBtn.disabled = true;
          revokeBtn.textContent = "Revoking…";
          const r = await sendMessage({
            type: "cb:share:call",
            body: { action: "revoke", slug: link.slug },
          });
          if (!modalEl) return;
          if (r && r.ok && r.data && r.data.ok) {
            row.remove();
            if (!listEl.children.length) listEl.textContent = "No active links yet.";
          } else {
            revokeBtn.disabled = false;
            revokeBtn.textContent = "Revoke";
            showError("Couldn't revoke the link. Try again.");
          }
        });
        row.appendChild(a);
        row.appendChild(meta);
        row.appendChild(copyBtn);
        row.appendChild(revokeBtn);
        listEl.appendChild(row);
      }
    }

    genBtn.addEventListener("click", async () => {
      errEl.style.display = "none";
      genBtn.disabled = true;
      genBtn.textContent = "Generating…";
      try {
        // Flush in-memory tab state to Supabase first so share-view's live
        // read includes what the publisher is looking at right now.
        if (__cb.saveTabs) __cb.saveTabs();
        const snapshot =
          __cb.tableView && __cb.tableView.getExportData
            ? __cb.tableView.getExportData()
            : null;
        const modules = [...modChecks.entries()]
          .filter(([, cb]) => cb.checked)
          .map(([id]) => id);
        const resp = await sendMessage({
          type: "cb:share:call",
          body: {
            action: "publish",
            workbookId,
            tabId,
            customerName: customerInput.value.trim(),
            scopeSnapshot: snapshot,
            options: {
              includeCredits: creditsCb.checked,
              modules,
              context: contextInput.value.trim(),
            },
          },
        });
        if (resp && resp.ok && resp.data && resp.data.ok && resp.data.url) {
          showResult(resp.data);
          refreshList();
        } else {
          const detail =
            (resp && resp.data && resp.data.error) ||
            (resp && resp.error) ||
            `status ${resp && resp.status}`;
          showError(`Couldn't create the link (${detail}).`);
        }
      } finally {
        genBtn.disabled = false;
        genBtn.textContent = "Generate link";
      }
    });

    // The backdrop is the fixed flex-centering layer (see export.js's modal
    // pattern) — the modal MUST be its child or it renders in normal page
    // flow, invisible behind Clay's UI.
    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    refreshList();
  };
})();
