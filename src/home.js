/**
 * Home-page "Canvases" tab.
 *
 * On app.clay.com/workspaces/:id/home, Clay renders a segmented control
 * (Workbooks | Table activity | Recents | Favorites). This module:
 *   1. Injects a fifth option, "Canvases", right after Workbooks.
 *   2. When it's clicked, overlays a position:fixed panel that covers the
 *      area below the tabs row — our own 2-column list (Name, Last opened)
 *      fed by the Supabase canvases table. The native heading/filters/table
 *      keep rendering underneath, invisible to the user.
 *   3. When any native option is clicked, removes our overlay.
 *
 * Why not a real radio input: the native control is React-controlled via the
 * `base-ui` library. We can't register a new option with the React state, so
 * we clone the markup/classes for a native look and manage checked state
 * ourselves. React still owns the 4 native options; our tab is a "ghost"
 * that overlays our own panel when picked.
 *
 * Why an overlay (not display:none on native nodes): mutating React-owned
 * subtrees (hiding children, flipping `data-checked` on native radios) sent
 * base-ui into an infinite update loop (React error #185). Covering with a
 * fixed-position panel leaves the native tree untouched, which keeps React
 * quiet.
 */
(function () {
  "use strict";

  const __cb = window.__cb;

  const TAB_ID = "cb-home-canvases-tab";
  const DIVIDER_ID = "cb-home-canvases-divider";
  const PANEL_ID = "cb-home-canvases-panel";
  const STYLE_ID = "cb-home-canvases-style";
  const FILTER_BAR_ID = "cb-home-owner-filter-bar";
  const POPOVER_ID = "cb-home-owner-popover";
  // Applied to the radiogroup while Canvases is the selected tab. We keep
  // native `data-checked` attributes untouched (modifying them while React
  // still owns the segmented-control state causes a "max update depth"
  // error — React and our handler fight over the attribute). Instead we
  // visually un-check the natives via CSS scoped to this attribute.
  const ACTIVE_ATTR = "data-cb-canvases-active";

  let active = false;
  // Cached clean-up handlers we attached to the 4 native options; removed
  // when we tear down so we don't leak listeners on re-injection.
  let nativeClickOffs = [];
  // Owner filter state. Empty string means "All owners". Reset to "" on
  // every deactivate so the filter starts fresh each mount.
  let selectedOwnerId = "";
  // Internal/External audience filter — only shown/applied in global mode
  // (Clay's internal workspace, 4515). "internal" = owner email ends with
  // @clay.com. Defaults to "internal"; reset on every deactivate. Kept inert
  // in workspace mode so we never hide an all-external customer list.
  let selectedAudience = "internal";
  // True while the global (all-workspaces) view is active. Gates whether the
  // audience filter is rendered and applied.
  let isGlobalMode = false;

  function isHomeUrl() {
    return window.location.pathname.endsWith("/home");
  }

  // Workspace id straight from the home URL (/workspaces/:id/home).
  // __cb.parseIdsFromUrl() only resolves when a /workbooks/ segment is present
  // (it returns null otherwise), so on /home it would give null — which would
  // silently drop the workspace filter AND never match the 4515 global gate.
  // Parse it ourselves so both work on the home page.
  function currentWorkspaceId() {
    const parts = window.location.pathname.split("/");
    const i = parts.indexOf("workspaces");
    return i !== -1 && parts[i + 1] ? parts[i + 1] : null;
  }

  function findRadioGroup() {
    // The HomeTab.tsx data attribute is the most specific signal. If the
    // bundler strips data-sentry-* attrs in some future build, fall back to
    // the generic role selector.
    return (
      document.querySelector('[role="radiogroup"][data-sentry-source-file="HomeTab.tsx"]') ||
      document.querySelector('[role="radiogroup"]')
    );
  }

  function getOptionsContainer(rg) {
    if (!rg) return null;
    // Redesigned home (HomeTab.tsx, 2026): the option spans are DIRECT
    // children of the radiogroup — each role=radio span followed by a hidden
    // <input> — with no wrapper div. The older layout nested the options
    // inside a single wrapper (rg.firstElementChild). Detect which by where
    // the role=radio spans actually live so injection works across both.
    const directRadios = Array.from(rg.children).filter(
      (c) => c.getAttribute("role") === "radio",
    );
    if (directRadios.length >= 2) return rg;
    const inner = rg.firstElementChild;
    if (inner) {
      const nested = Array.from(inner.children).filter(
        (c) => c.getAttribute("role") === "radio",
      );
      if (nested.length >= 2) return inner;
    }
    return rg;
  }

  function getNativeOptions(inner) {
    // Direct-child spans only — our injected span is also role=radio and would
    // otherwise show up here.
    return Array.from(inner.children).filter(
      (el) => el.tagName === "SPAN" && el.getAttribute("role") === "radio" && el.id !== TAB_ID,
    );
  }

  function setOurTabChecked(checked) {
    // Only ever called on our own span, never on React-owned natives.
    const el = document.getElementById(TAB_ID);
    if (!el) return;
    if (checked) {
      el.setAttribute("data-checked", "");
      el.removeAttribute("data-unchecked");
      el.setAttribute("aria-checked", "true");
    } else {
      el.setAttribute("data-unchecked", "");
      el.removeAttribute("data-checked");
      el.setAttribute("aria-checked", "false");
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // While our tab is "active", visually un-check any native option that
    // still has React's data-checked attribute (typically "Workbooks" —
    // since React never got the click, its internal state doesn't change).
    // The selectors match the base-ui classes from the reference option so
    // the override hits the same specificity as the checked-state styling.
    style.textContent = `
      [role="radiogroup"][${ACTIVE_ATTR}] > div > span[role="radio"][data-checked]:not(#${TAB_ID}) {
        border-color: transparent !important;
      }
      [role="radiogroup"][${ACTIVE_ATTR}] > div > span[role="radio"][data-checked]:not(#${TAB_ID}) > div {
        color: var(--color-content-secondary, currentColor) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function buildCanvasesTab(referenceOption) {
    const span = document.createElement("span");
    span.id = TAB_ID;
    span.setAttribute("role", "radio");
    span.setAttribute("tabindex", "-1");
    // Start unchecked; activateCanvases() flips this when the user clicks.
    span.setAttribute("aria-checked", "false");
    span.setAttribute("data-unchecked", "");
    // Copy the outer option's Tailwind classes so our tab inherits the exact
    // hover/focus/checked styling that the base-ui segmented control gives
    // the native options.
    span.className = referenceOption.className;

    const inner = document.createElement("div");
    const refInner = referenceOption.firstElementChild;
    if (refInner) inner.className = refInner.className;
    // Key icon + branded label, laid out inline to mirror the toolbar button.
    inner.style.display = "inline-flex";
    inner.style.alignItems = "center";
    inner.style.gap = "6px";

    const icon = document.createElement("img");
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    icon.style.width = "14px";
    icon.style.height = "14px";
    icon.style.flexShrink = "0";
    icon.style.objectFit = "contain";
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      icon.src = chrome.runtime.getURL("icons/key-icon.png");
    }

    const label = document.createElement("span");
    // Match the toolbar button gating: internal GTMEs see "Quartz", everyone
    // else sees "Scoping" (same `internal_branding` flag used at line ~401).
    label.textContent =
      __cb.hasFeature && __cb.hasFeature("internal_branding") ? "Quartz" : "Scoping";

    inner.appendChild(icon);
    inner.appendChild(label);
    span.appendChild(inner);

    return span;
  }

  function tryInjectCanvasesTab() {
    if (!isHomeUrl()) return;
    if (document.getElementById(TAB_ID)) return;

    const rg = findRadioGroup();
    if (!rg) return;

    const inner = getOptionsContainer(rg);
    if (!inner) return;

    const nativeOptions = getNativeOptions(inner);
    if (nativeOptions.length < 2) return;

    const secondOption = nativeOptions[1];
    const canvasesTab = buildCanvasesTab(nativeOptions[0]);

    canvasesTab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateCanvases();
    });

    // Insert as the SECOND option: All files | Quartz | Recents | Favorites.
    // The new control is a w-fit pill with no inter-option dividers, so we
    // just drop our span in (it sits before the second option's span; the
    // hidden <input> siblings base-ui uses are left untouched).
    inner.insertBefore(canvasesTab, secondOption);

    // Re-injection path: when React re-renders the segmented control (e.g. the
    // Show more/less toggle rebuilds the home header) it can drop our foreign
    // node. The body MutationObserver calls us again to re-add it — if the
    // panel is still open, restore the checked look so the tab keeps reading
    // as selected and the natives stay visually un-checked.
    if (active) {
      ensureStyles();
      rg.setAttribute(ACTIVE_ATTR, "");
      setOurTabChecked(true);
    }

    // Wire deactivation on the existing native options. We record the
    // teardown handlers so a future re-inject can remove them cleanly.
    for (const opt of nativeOptions) {
      const handler = () => {
        if (active) deactivateCanvases();
      };
      opt.addEventListener("click", handler);
      nativeClickOffs.push(() => opt.removeEventListener("click", handler));
    }
  }

  function removeInjectedTab() {
    const tab = document.getElementById(TAB_ID);
    const divider = document.getElementById(DIVIDER_ID);
    if (tab) tab.remove();
    if (divider) divider.remove();

    for (const off of nativeClickOffs) {
      try {
        off();
      } catch {
        // Node may have been detached already; nothing to clean up.
      }
    }
    nativeClickOffs = [];
  }

  function activateCanvases() {
    if (active) return;
    active = true;

    const rg = findRadioGroup();
    if (!rg) return;

    // Mark our tab checked. Do NOT mutate native attributes — React owns
    // them and reconciling our flips would re-enter its update loop. The
    // CSS from ensureStyles() dims whichever native is still data-checked.
    ensureStyles();
    rg.setAttribute(ACTIVE_ATTR, "");
    setOurTabChecked(true);

    // Overlay strategy: rather than hide React-managed nodes (which
    // triggers React error #185 — "Maximum update depth exceeded" — via
    // the segmented-control's internal effect cycle), we position an
    // opaque panel on top of the area below the sticky header. The native
    // table keeps rendering underneath, invisible to the user. React's
    // tree is not mutated beyond our stable injected tab in the
    // radiogroup, so the update loop stays quiet.
    const stickyHeader = rg.parentElement?.parentElement;
    const contentRoot = stickyHeader?.parentElement;
    if (!stickyHeader || !contentRoot) return;

    mountOverlayPanel(contentRoot, stickyHeader);
  }

  function deactivateCanvases() {
    if (!active) return;
    active = false;

    setOurTabChecked(false);
    const rg = findRadioGroup();
    if (rg) rg.removeAttribute(ACTIVE_ATTR);

    // Tear down the Owner filter popover if it was left open when the tab
    // flipped. The popover lives on document.body so it won't be caught by
    // the panel removal below.
    closeOwnerPopover();
    selectedOwnerId = "";
    selectedAudience = "internal";
    isGlobalMode = false;

    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      if (typeof panel._cbTeardown === "function") panel._cbTeardown();
      panel.remove();
    }
  }

  function mountOverlayPanel(contentRoot, stickyHeader) {
    // Panel is an absolutely-positioned sibling that covers the native
    // table area. We attach to document.body so nothing inside React's
    // tree changes, then reposition relative to stickyHeader on scroll/
    // resize. The bg-bg-primary class gives us the same page background
    // as Clay's native content so the underlying table is fully masked.
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "flex flex-col bg-bg-primary overflow-y-auto";
    panel.style.position = "fixed";
    panel.style.zIndex = "5";

    // Heading row — matches Clay's native layout for the Workbooks heading.
    // pb-3 gives breathing room between the heading and the filter bar's
    // top border below it (Clay leaves the heading tight; we relax it).
    const headingRow = document.createElement("div");
    headingRow.className =
      "mx-auto grid w-full grid-cols-[1fr_auto] gap-1 px-8 pt-2 pb-3";
    const headingWrap = document.createElement("div");
    headingWrap.className = "flex max-w-full flex-row items-center gap-2";
    // Clay-heart icon next to the heading (same chrome.runtime.getURL pattern
    // as the tab's key icon). Must be listed in web_accessible_resources.
    const heartIcon = document.createElement("img");
    heartIcon.alt = "";
    heartIcon.setAttribute("aria-hidden", "true");
    heartIcon.style.width = "22px";
    heartIcon.style.height = "22px";
    heartIcon.style.flexShrink = "0";
    heartIcon.style.objectFit = "contain";
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      heartIcon.src = chrome.runtime.getURL("icons/clay-heart.png");
    }
    const heading = document.createElement("h4");
    heading.className = "truncate text-xl font-bold font-sans tracking-tight";
    heading.textContent = "You're gonna love this new tool";
    headingWrap.appendChild(heartIcon);
    headingWrap.appendChild(heading);
    headingRow.appendChild(headingWrap);

    // Filter bar — mirrors Clay's HomepageLayoutFiltersContainer: a full-
    // width bar with a `border-t` separating the heading from the filters
    // and `pt-2` sitting the pill a few pixels below that divider. We add
    // `pb-2` for symmetry so the table doesn't butt up against the pill.
    const filterBar = document.createElement("div");
    filterBar.id = FILTER_BAR_ID;
    filterBar.className =
      "flex flex-row gap-2 bg-bg-primary px-8 pt-2 pb-2 " +
      "border-t border-border-secondary";

    const statusEl = document.createElement("div");
    statusEl.className = "px-8 py-4 text-sm text-content-secondary";
    statusEl.textContent = "Loading…";

    // The table wrap is intentionally edge-to-edge (no horizontal padding):
    // Clay's native Workbooks table sits flush against the content root so
    // that each cell's bottom border spans the full width, producing the
    // classic full-width row dividers. Horizontal indentation is restored
    // on the first/last cells via `first:pl-8 last:pr-8` so that the text
    // in the Name column still aligns with the "Canvases" heading above.
    const tableWrap = document.createElement("div");
    tableWrap.className = "pb-8";

    panel.appendChild(headingRow);
    panel.appendChild(filterBar);
    panel.appendChild(statusEl);
    panel.appendChild(tableWrap);

    // Position below the tabs row (not the full sticky header — we want to
    // cover Clay's "Workbooks" heading and Owner/Filters row too, which are
    // siblings of the tabs row inside the sticky header). We re-measure on
    // every scroll or resize tick to stay pinned while the page shifts.
    function positionPanel() {
      const tabsRow = stickyHeader.firstElementChild;
      const rect = tabsRow
        ? tabsRow.getBoundingClientRect()
        : stickyHeader.getBoundingClientRect();
      const rootRect = contentRoot.getBoundingClientRect();
      panel.style.top = `${rect.bottom}px`;
      panel.style.left = `${rootRect.left}px`;
      panel.style.width = `${rootRect.width}px`;
      panel.style.height = `${window.innerHeight - rect.bottom}px`;
    }
    positionPanel();
    const reposition = () => positionPanel();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);

    // The "Show more/less" toggle collapses/expands the greeting + action
    // cards that sit ABOVE the sticky header, shifting the tabs row up or down
    // WITHOUT firing a scroll or resize event — which would otherwise leave
    // the panel pinned to a stale top, floating away from the tabs. Observe
    // the content root + sticky header so any such height change re-pins us.
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(reposition);
      ro.observe(contentRoot);
      ro.observe(stickyHeader);
    }
    // Stash the teardown hooks on the panel so deactivate can find them.
    panel._cbTeardown = () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (ro) ro.disconnect();
    };

    document.body.appendChild(panel);

    loadCanvases(statusEl, tableWrap, filterBar);
  }

  async function loadCanvases(statusEl, tableWrap, filterBar) {
    const supa = window.__cbSupabase;
    if (!supa) {
      statusEl.textContent = "Supabase client failed to load.";
      return;
    }

    // user.js kicks off /v3/me on startup and stores the promise on
    // __cb.userIdReady. Awaiting here means we don't query Supabase with a
    // missing user_id on first paint.
    try {
      if (__cb.userIdReady) await __cb.userIdReady;
    } catch {
      // ensureUserId() already caches in localStorage, so __cb.userId may
      // still be set. We carry on and let the null-check below handle it.
    }

    const userId = __cb.userId;
    if (!userId) {
      statusEl.textContent =
        "Couldn't identify your Clay user. Make sure you're logged in to app.clay.com.";
      return;
    }

    // The home page URL always carries a workspace id (this tab is only
    // injected on /workspaces/:id/home). In workspace mode it's the hard
    // filter that scopes the list to the workspace being viewed; in global
    // mode (below) it's only used to detect the internal workspace.
    const workspaceId = currentWorkspaceId();

    // Global mode: on Clay's own internal workspace (4515) an internal user
    // sees every canvas across ALL workspaces. Everywhere else (and for any
    // non-internal user) the list is scoped to the current workspace — but
    // still shows ALL members' canvases, not just the caller's. `is_internal`
    // is surfaced to the content script as the internal_branding feature (the
    // mint grants the whole INTERNAL_FEATURES set iff is_internal), so
    // hasFeature is an exact proxy for the JWT claim that RLS reads.
    const GLOBAL_WORKSPACE_ID = "4515";
    const globalMode =
      workspaceId === GLOBAL_WORKSPACE_ID &&
      !!(__cb.hasFeature && __cb.hasFeature("internal_branding"));
    isGlobalMode = globalMode;

    try {
      // Query the canvases table directly so the list is workspace-wide (every
      // member's canvases), not just the caller's contributor rows. RLS allows
      // this: a member reads any canvas in their workspace; an internal caller
      // reads every canvas in every workspace. workbook_name is populated by
      // tabs.js on every save (pushToSupabase); falls back to the opaque
      // workbook_id for rows written by an older extension build.
      const rowsQuery = {
        select: "workbook_id,workspace_id,workbook_name,updated_at",
        order: "updated_at.desc",
        limit: "500",
      };
      if (!globalMode && workspaceId) {
        rowsQuery.workspace_id = `eq.${workspaceId}`;
      }
      const canvasRows = await supa.supabaseFetch("canvases", "GET", {
        query: rowsQuery,
      });

      if (!canvasRows || canvasRows.length === 0) {
        statusEl.textContent = globalMode
          ? "No canvases yet."
          : "No canvases in this workspace yet.";
        tableWrap.innerHTML = "";
        return;
      }

      // Normalize into the shape renderTable expects (it reads row.canvases.*
      // and row.last_accessed_at). The "Last updated" column now reflects the
      // canvas's updated_at, since the list is no longer personal.
      const rows = canvasRows.map((c) => ({
        workbook_id: c.workbook_id,
        last_accessed_at: c.updated_at,
        canvases: {
          workspace_id: c.workspace_id,
          workbook_name: c.workbook_name,
          updated_at: c.updated_at,
        },
      }));

      // Second round-trip: for every workbook in the result, fetch all
      // contributors sorted by first_accessed_at asc. The earliest row per
      // workbook is the owner. We also pull the owner's email so we can flag
      // internal (@clay.com) owners for the Internal/External filter.
      const workbookIds = rows.map((r) => r.workbook_id);
      let ownersByWorkbook = new Map();
      try {
        const ownerRows = await supa.supabaseFetch("canvas_contributors", "GET", {
          query: {
            workbook_id: `in.(${workbookIds.join(",")})`,
            select:
              "workbook_id,user_id,first_accessed_at,users(name,profile_picture,email)",
            order: "first_accessed_at.asc",
          },
        });
        for (const r of ownerRows || []) {
          if (ownersByWorkbook.has(r.workbook_id)) continue;
          const email = r.users?.email || null;
          ownersByWorkbook.set(r.workbook_id, {
            id: r.user_id,
            name: r.users?.name || r.user_id,
            profilePicture: r.users?.profile_picture || null,
            email,
            isInternal: (email || "").trim().toLowerCase().endsWith("@clay.com"),
          });
        }
      } catch (err) {
        // Owner data is a progressive enhancement — if it fails, we still
        // want to render the list. The Owner cells will show "—".
        console.warn("[Clay Scoping] owners fetch failed:", err);
      }

      statusEl.style.display = "none";
      renderTable(tableWrap, rows, ownersByWorkbook, userId);
      renderFilterBar(filterBar, ownersByWorkbook, userId, tableWrap, globalMode);
    } catch (err) {
      console.warn("[Clay Scoping] home canvases fetch failed:", err);
      statusEl.textContent = "Couldn't load canvases from the server.";
    }
  }

  function formatRelative(isoDate) {
    if (!isoDate) return "never";
    const then = new Date(isoDate).getTime();
    if (isNaN(then)) return "never";
    const diff = Date.now() - then;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(isoDate).toLocaleDateString();
  }

  /**
   * Small rounded avatar — `<img>` when `profilePicture` is set, otherwise
   * a `<div>` with the first initial. Mirrors the avatar rendering in
   * src/canvas/collaborators.js so Home and the canvas widget look
   * consistent.
   *
   * Why not `<div style="background-image: url(...)">` + `bg-cover`:
   * Clay's Tailwind v4 build tree-shakes unused utilities, and neither
   * `bg-cover` nor `bg-center` make it into the final CSS. Without them
   * a 96px Google avatar renders at natural size inside the 20px cell
   * and shows only its top-left corner (a dark blob). An `<img>` with
   * inline `object-fit: cover` sidesteps Tailwind entirely.
   */
  function buildAvatar(owner, sizeClass) {
    const size = sizeClass || "w-5 h-5";
    if (owner?.profilePicture) {
      const img = document.createElement("img");
      img.src = owner.profilePicture;
      img.alt = "";
      img.decoding = "async";
      img.loading = "lazy";
      // referrerpolicy: Google avatars (lh3.googleusercontent.com) reject
      // hot-linked requests carrying a Clay referer header. Using
      // "no-referrer" makes the image load in any embedded context.
      img.referrerPolicy = "no-referrer";
      img.className = `${size} rounded-full shrink-0 object-cover bg-bg-secondary`;
      // Inline fallbacks in case object-cover's Tailwind utility is also
      // missing from Clay's build in some future version.
      img.style.objectFit = "cover";
      img.style.objectPosition = "center";
      if (owner?.name) img.title = owner.name;
      return img;
    }

    const el = document.createElement("div");
    el.className =
      `${size} rounded-full shrink-0 flex items-center justify-center ` +
      "text-xs font-medium bg-bg-secondary text-content-secondary";
    el.textContent = (owner?.name || "?").trim().charAt(0).toUpperCase();
    if (owner?.name) el.title = owner.name;
    return el;
  }

  function renderTable(mount, rows, ownersByWorkbook, currentUserId) {
    mount.innerHTML = "";

    // Mirror Clay's native Workbooks table (verified via Playwright against
    // the live page). The table itself is a CSS grid; thead, tbody, and
    // each row use grid-cols-subgrid so cells line up across rows. Borders
    // live on the cells (TH/TD), not the rows, which is why a data row
    // without borders and a per-cell border-b still produces the familiar
    // horizontal divider pattern. Three columns: Name (flexes), Owner,
    // and Last opened.
    const TABLE_CLASS =
      "grid [--table-border-row-color:var(--color-border-tertiary)] text-sm/6 min-w-full text-left";
    const THEAD_CLASS =
      "text-content-primary col-span-full grid w-full grid-cols-subgrid content-baseline";
    const HEAD_TR_CLASS =
      "col-span-full grid w-full grid-cols-subgrid content-baseline";
    // Clay uses `first:pl-(--gutter,--spacing(2))` / `last:pr-(--gutter,...)`
    // on its TH/TD to indent the first and last column content by 32 px
    // (the `--gutter` value) while keeping the cell borders edge-to-edge.
    // Those Tailwind utilities aren't in Clay's build, so we apply the 32 px
    // padding inline on the first and last cells (see the loop below).
    const TH_CLASS =
      "truncate p-2 text-xs font-semibold whitespace-pre-wrap text-content-secondary " +
      "border-b border-t border-solid";
    const TBODY_CLASS =
      "col-span-full grid w-full grid-cols-subgrid content-baseline";
    const DATA_TR_CLASS =
      "group h-(--row-height) col-span-full grid w-full grid-cols-subgrid " +
      "content-baseline hover:bg-border-primary/2.5";
    const TD_CLASS =
      "truncate text-sm text-wrap whitespace-pre-wrap relative px-2 " +
      "py-2 border-b border-solid " +
      "border-(--table-border-row-color) flex min-h-(--row-height) w-full " +
      "items-center";

    const table = document.createElement("table");
    table.className = TABLE_CLASS;
    // Name flexes, Owner gets a fixed 220px (wide enough for "Firstname
    // Lastname (you)"), Last opened stays at 180px to match Clay's
    // workbooks list.
    table.style.gridTemplateColumns = "minmax(20vw, 1fr) 220px 180px";

    const thead = document.createElement("thead");
    thead.className = THEAD_CLASS;
    const headRow = document.createElement("tr");
    headRow.className = HEAD_TR_CLASS;
    const headers = ["Name", "Owner", "Last updated"];
    for (let i = 0; i < headers.length; i++) {
      const th = document.createElement("th");
      th.className = TH_CLASS;
      th.textContent = headers[i];
      if (i === 0) th.style.paddingLeft = "32px";
      if (i === headers.length - 1) th.style.paddingRight = "32px";
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    tbody.className = TBODY_CLASS;

    for (const row of rows) {
      const workspaceId = row.canvases?.workspace_id;
      const workbookId = row.workbook_id;
      const name = row.canvases?.workbook_name || workbookId;
      const owner = ownersByWorkbook?.get(workbookId) || null;

      const tr = document.createElement("tr");
      tr.className = DATA_TR_CLASS;
      // Fixed row height mirrors Clay's 46px rows so the table doesn't
      // feel tighter than the native Workbooks list. The variable is
      // referenced by `h-(--row-height)` on the row and
      // `min-h-(--row-height)` on the cell.
      tr.style.setProperty("--row-height", "46px");
      // Used by applyRowFilters() to hide/show rows via display:none
      // without re-rendering the tbody.
      tr.dataset.ownerId = owner?.id || "";
      // "1" when the owner's email is @clay.com — drives the Internal/External
      // filter in global mode.
      tr.dataset.ownerInternal = owner?.isInternal ? "1" : "0";

      if (workspaceId) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => {
          // Pre-seed the "sticky open" flag so the canvas auto-opens on
          // the destination page. We used to rely on a "#cb-open" URL
          // fragment but Clay's router drops it when it redirects from
          // /workbooks/{id}/ to the default table URL via replaceState.
          // localStorage survives the redirect. The flag is the same one
          // overlay.js sets when the canvas is opened normally and is
          // consumed by tryInjectIntoToolbar() in src/toolbar.js — and
          // cleared by closeCanvas(), so there's no long-term pollution.
          localStorage.setItem(`cb-open-${workbookId}`, "1");
          window.location.href = `/workspaces/${workspaceId}/workbooks/${workbookId}/`;
        });
      } else {
        // Older rows may not have workspace_id embedded — can't build the
        // URL. Dim and disable the row rather than navigating to a broken
        // path.
        tr.style.cursor = "not-allowed";
        tr.style.opacity = "0.5";
      }

      const nameCell = document.createElement("td");
      nameCell.className = TD_CLASS;
      nameCell.style.paddingLeft = "32px";
      nameCell.textContent = name;

      const ownerCell = document.createElement("td");
      ownerCell.className = TD_CLASS;
      if (owner) {
        const ownerWrap = document.createElement("div");
        ownerWrap.className = "flex items-center gap-2 min-w-0";
        ownerWrap.appendChild(buildAvatar(owner));
        const ownerName = document.createElement("span");
        ownerName.className = "truncate";
        ownerName.textContent =
          owner.id === currentUserId ? `${owner.name} (you)` : owner.name;
        ownerWrap.appendChild(ownerName);
        ownerCell.appendChild(ownerWrap);
      } else {
        // No contributors fetched — fallback dash.
        ownerCell.textContent = "—";
        ownerCell.classList.add("text-content-secondary");
      }

      const timeCell = document.createElement("td");
      // Muted color on the timestamp, matching Clay's treatment of "Last
      // opened by me" / "Created at" columns.
      timeCell.className = TD_CLASS + " text-content-secondary";
      timeCell.style.paddingRight = "32px";
      timeCell.textContent = formatRelative(row.last_accessed_at);

      tr.appendChild(nameCell);
      tr.appendChild(ownerCell);
      tr.appendChild(timeCell);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    mount.appendChild(table);
  }

  /**
   * Show/hide rows based on the currently-selected owner id AND the audience
   * (Internal/External) filter. Owner: empty string means "All owners".
   * Audience: only applied in global mode (where the pill is rendered) so a
   * default-Internal filter never blanks an all-external workspace list.
   * Using display:none rather than re-rendering keeps click handlers wired
   * and DOM state stable.
   */
  function applyRowFilters(tableWrap) {
    const rows = tableWrap.querySelectorAll("tbody tr");
    for (const tr of rows) {
      const ownerOk =
        !selectedOwnerId || tr.dataset.ownerId === selectedOwnerId;
      const audienceOk =
        !isGlobalMode ||
        !selectedAudience ||
        (selectedAudience === "internal"
          ? tr.dataset.ownerInternal === "1"
          : tr.dataset.ownerInternal === "0");
      tr.style.display = ownerOk && audienceOk ? "" : "none";
    }
  }

  /**
   * Build the "Owner | {selectedName}" composite pill. Clicking the right
   * half opens the popover. Mirrors the DOM Clay uses on the home-page
   * HomepageFilters.tsx component.
   */
  function renderFilterBar(filterBar, ownersByWorkbook, currentUserId, tableWrap, globalMode) {
    filterBar.innerHTML = "";

    // Internal/External segmented control — global mode only. In workspace
    // mode it's omitted (a customer workspace is all-external, so defaulting
    // to Internal would hide every row).
    if (globalMode) {
      filterBar.appendChild(buildAudiencePill(tableWrap));
    }

    // Gather the unique owners seen across the fetched rows. Build the
    // popover list from these so the dropdown never contains users who
    // aren't the owner of at least one visible canvas.
    const uniqueOwners = new Map();
    for (const owner of ownersByWorkbook.values()) {
      if (!uniqueOwners.has(owner.id)) uniqueOwners.set(owner.id, owner);
    }

    const pill = document.createElement("div");
    pill.className =
      "h-6 flex w-fit items-center overflow-hidden rounded-sm border " +
      "border-border-primary";

    const labelWrap = document.createElement("div");
    labelWrap.className = "flex h-full items-center px-1.5";
    const labelP = document.createElement("p");
    labelP.className = "text-xs font-medium text-content-primary";
    labelP.textContent = "Owner";
    labelWrap.appendChild(labelP);

    const triggerWrap = document.createElement("div");
    triggerWrap.className = "flex h-full border-l border-border-primary";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className =
      "text-xs font-medium text-content-primary px-1.5 h-full " +
      "hover:bg-content-primary/5 flex items-center gap-1 cursor-pointer";
    const triggerLabel = document.createElement("span");
    triggerLabel.textContent = "All";
    const chevron = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    chevron.setAttribute("viewBox", "0 0 12 12");
    chevron.setAttribute("fill", "currentColor");
    chevron.classList.add("size-3");
    const path = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    path.setAttribute("d", "M3 4.5l3 3 3-3");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.25");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    chevron.appendChild(path);
    trigger.appendChild(triggerLabel);
    trigger.appendChild(chevron);

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (document.getElementById(POPOVER_ID)) {
        closeOwnerPopover();
        return;
      }
      openOwnerPopover(
        trigger,
        uniqueOwners,
        currentUserId,
        (newSelection) => {
          selectedOwnerId = newSelection.id;
          triggerLabel.textContent = newSelection.label;
          applyRowFilters(tableWrap);
        },
      );
    });

    triggerWrap.appendChild(trigger);
    pill.appendChild(labelWrap);
    pill.appendChild(triggerWrap);
    filterBar.appendChild(pill);

    // Apply current filters on mount. In global mode the default audience is
    // "internal", so external-owned canvases are hidden on first paint.
    applyRowFilters(tableWrap);
  }

  /**
   * Two-segment "Internal | External" control shown only in global mode.
   * Filters rows by whether the canvas owner's email is @clay.com. Mirrors
   * the Owner pill's bordered-pill styling; the active segment uses inline
   * token colors (Clay's Tailwind build tree-shakes unused bg utilities, so
   * we don't rely on a class for the active background).
   */
  function buildAudiencePill(tableWrap) {
    const pill = document.createElement("div");
    pill.className =
      "h-6 flex w-fit items-center overflow-hidden rounded-sm border " +
      "border-border-primary";

    const options = [
      { id: "internal", label: "Internal" },
      { id: "external", label: "External" },
    ];

    options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.audience = opt.id;
      const divider = i > 0 ? "border-l border-border-primary " : "";
      btn.className =
        divider +
        "text-xs font-medium px-2 h-full cursor-pointer flex items-center";
      btn.textContent = opt.label;
      styleAudienceSegment(btn, opt.id === selectedAudience);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectedAudience === opt.id) return;
        selectedAudience = opt.id;
        for (const b of pill.querySelectorAll("button[data-audience]")) {
          styleAudienceSegment(b, b.dataset.audience === selectedAudience);
        }
        applyRowFilters(tableWrap);
      });
      pill.appendChild(btn);
    });

    return pill;
  }

  function styleAudienceSegment(btn, active) {
    if (active) {
      btn.style.backgroundColor = "var(--color-bg-secondary, rgba(0,0,0,0.06))";
      btn.style.color = "var(--color-content-primary, currentColor)";
    } else {
      btn.style.backgroundColor = "transparent";
      btn.style.color = "var(--color-content-secondary, currentColor)";
    }
  }

  /**
   * Floating popover with search, "All owners", current user pinned,
   * separator, then other owners alphabetically. Attached to document.body
   * so it floats above the overlay panel without z-index fights. Closes on
   * outside click, Escape, or re-click of the trigger.
   */
  function openOwnerPopover(trigger, uniqueOwners, currentUserId, onSelect) {
    closeOwnerPopover();

    const popover = document.createElement("div");
    popover.id = POPOVER_ID;
    popover.className =
      "w-72 rounded-lg p-1 bg-bg-primary border-[0.5px] border-border-primary " +
      "shadow-lg flex flex-col gap-0.5";
    popover.style.position = "fixed";
    popover.style.zIndex = "9999";

    const rect = trigger.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.left = `${rect.left}px`;

    const searchWrap = document.createElement("div");
    searchWrap.className =
      "flex items-center gap-2 rounded border border-border-primary px-2 " +
      "py-1 mx-1 mt-1 mb-0.5";
    const searchIcon = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    searchIcon.setAttribute("viewBox", "0 0 16 16");
    searchIcon.setAttribute("fill", "currentColor");
    searchIcon.classList.add(
      "size-4",
      "text-content-placeholder",
      "shrink-0",
    );
    const searchPath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    searchPath.setAttribute(
      "d",
      "M11.5 10.3l2.9 2.9a.75.75 0 11-1.05 1.05l-2.9-2.9a5.5 5.5 0 111.05-1.05zM6.75 11A4.25 4.25 0 106.75 2.5a4.25 4.25 0 000 8.5z",
    );
    searchIcon.appendChild(searchPath);
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "Search";
    searchInput.className =
      "w-full bg-transparent text-sm focus:outline-hidden " +
      "placeholder:text-content-placeholder";
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);
    popover.appendChild(searchWrap);

    const list = document.createElement("div");
    list.className = "flex flex-col gap-0.5 max-h-80 overflow-y-auto";
    popover.appendChild(list);

    const ITEM_CLASS =
      "rounded-md px-3 py-2 text-sm text-content-primary " +
      "hover:bg-bg-primary-hover cursor-pointer flex items-center gap-2 " +
      "text-left w-full";

    function buildItem(owner, label, isSelected) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = ITEM_CLASS;
      btn.dataset.ownerId = owner?.id || "";
      // Lowercase search index so the input filter is case-insensitive.
      btn.dataset.search = (owner?.name || label).toLowerCase();

      if (owner) {
        btn.appendChild(buildAvatar(owner, "w-5 h-5"));
      } else {
        // "All owners" gets a neutral people glyph rather than an avatar.
        const icon = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        icon.setAttribute("viewBox", "0 0 20 20");
        icon.setAttribute("fill", "currentColor");
        icon.classList.add("size-5", "text-content-secondary", "shrink-0");
        const p = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        p.setAttribute(
          "d",
          "M7 8a3 3 0 100-6 3 3 0 000 6zM14.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 16a5.5 5.5 0 0111 0v.5h-11V16zM13 16.5v-.5a6.48 6.48 0 00-1.5-4.16A4.5 4.5 0 0118.5 16v.5h-5.5z",
        );
        icon.appendChild(p);
        btn.appendChild(icon);
      }

      const labelSpan = document.createElement("span");
      labelSpan.className = "flex-1 truncate";
      labelSpan.textContent = label;
      btn.appendChild(labelSpan);

      if (isSelected) {
        const check = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        check.setAttribute("viewBox", "0 0 16 16");
        check.setAttribute("fill", "currentColor");
        check.classList.add("size-4", "text-content-action", "shrink-0");
        const cp = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        cp.setAttribute(
          "d",
          "M13.28 4.22a.75.75 0 010 1.06l-6 6a.75.75 0 01-1.06 0l-3-3a.75.75 0 011.06-1.06L6.75 9.69l5.47-5.47a.75.75 0 011.06 0z",
        );
        check.appendChild(cp);
        btn.appendChild(check);
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelect({
          id: owner?.id || "",
          label: owner ? label.replace(/ \(you\)$/, "") : "All",
        });
        closeOwnerPopover();
      });
      return btn;
    }

    // 1. "All owners"
    list.appendChild(
      buildItem(null, "All owners", selectedOwnerId === ""),
    );

    // 2. Current user pinned (only when they're the owner of at least one canvas)
    const me = uniqueOwners.get(currentUserId);
    if (me) {
      list.appendChild(
        buildItem(me, `${me.name} (you)`, selectedOwnerId === me.id),
      );

      const sep = document.createElement("hr");
      sep.className = "my-1 border-t border-border-tertiary";
      list.appendChild(sep);
    }

    // 3. Other owners alphabetically
    const others = Array.from(uniqueOwners.values())
      .filter((o) => o.id !== currentUserId)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    for (const o of others) {
      list.appendChild(buildItem(o, o.name, selectedOwnerId === o.id));
    }

    document.body.appendChild(popover);
    // Delay focus by a tick so the triggering click doesn't also submit
    // the input as a default form action.
    setTimeout(() => searchInput.focus(), 0);

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      for (const btn of list.querySelectorAll("button")) {
        const match = !q || (btn.dataset.search || "").includes(q);
        btn.style.display = match ? "" : "none";
      }
    });

    // Close on outside click / Escape. We don't register these until the
    // current click settles, otherwise the triggering click itself would
    // immediately dismiss us.
    function onDocClick(e) {
      if (popover.contains(e.target)) return;
      if (trigger.contains(e.target)) return;
      closeOwnerPopover();
    }
    function onKeydown(e) {
      if (e.key === "Escape") closeOwnerPopover();
    }
    popover._cbTeardown = () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKeydown);
    }, 0);
  }

  function closeOwnerPopover() {
    const popover = document.getElementById(POPOVER_ID);
    if (!popover) return;
    if (typeof popover._cbTeardown === "function") popover._cbTeardown();
    popover.remove();
  }

  // ---- boot ------------------------------------------------------------

  function sync() {
    if (isHomeUrl()) {
      tryInjectCanvasesTab();
    } else {
      // Leaving /home. Any hidden displays we'd need to restore are on
      // DOM nodes that no longer exist in the tree, so deactivate() is a
      // cheap no-op past the first cleanup.
      if (active) deactivateCanvases();
      removeInjectedTab();
    }
  }

  let lastUrl = window.location.href;
  // A single body-level observer covers two cases at once:
  //   - SPA navigation (window.location.href changed).
  //   - React re-rendered the home DOM and our tab disappeared.
  // tryInjectCanvasesTab() is idempotent so we don't need debouncing.
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      if (active) deactivateCanvases();
    }
    sync();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync);
  } else {
    sync();
  }
})();
