/**
 * Resolves the Clay user identity for the current browser session.
 *
 * Strategy: Hit Clay's GET /v3/me endpoint with credentials:"include" so the
 * existing app.clay.com session cookie is sent. The response includes the
 * user's id, email, and fullName which we use as the identity in Supabase.
 *
 * The result is cached in window.__cb (memory) AND localStorage (persists
 * across page loads so we don't make this fetch on every script init).
 */
(function () {
  "use strict";

  const __cb = window.__cb;
  const STORAGE_KEY = "cb-user-id";

  function loadCachedUser() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === "string") return parsed;
      return null;
    } catch {
      return null;
    }
  }

  function saveCachedUser(user) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } catch (e) {
      console.warn("[Clay Scoping] failed to cache user identity:", e);
    }
  }

  /**
   * Fetches the current user from Clay. Returns a normalized
   * { id, email, name, profilePicture } object, or null if the fetch fails.
   *
   * `id` is always a string (Clay returns a numeric id; we stringify so the
   * Supabase `text` column receives a consistent type).
   */
  async function fetchClayUser() {
    try {
      const res = await fetch("https://api.clay.com/v3/me", {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.id == null) return null;
      return {
        id: String(data.id),
        email: data.email || null,
        name: data.fullName || data.name || data.username || data.email || null,
        profilePicture: data.profilePicture || null,
      };
    } catch (err) {
      console.warn("[Clay Scoping] /v3/me fetch failed:", err);
      return null;
    }
  }

  /**
   * Fire-and-forget upsert into the Supabase `users` table. Called once per
   * page load after a successful /v3/me fetch so the collaborators widget
   * and popup can display names/avatars for anyone who has used the
   * extension.
   */
  function pushUserToSupabase(user) {
    const supa = window.__cbSupabase;
    if (!supa || !user?.id) return;
    supa.supabaseFetch("users", "POST", {
      prefer: "resolution=merge-duplicates",
      body: {
        id: user.id,
        name: user.name,
        profile_picture: user.profilePicture,
        email: user.email,
        updated_at: new Date().toISOString(),
      },
    }).catch(err => console.warn("[Clay Scoping] user upsert failed:", err));
  }

  /**
   * Idempotent: ensures __cb.userId / __cb.user are set. Uses the cached value
   * synchronously when available, then refreshes from /v3/me in the background.
   */
  __cb.ensureUserId = async function ensureUserId() {
    const cached = loadCachedUser();
    if (cached) {
      __cb.userId = cached.id;
      __cb.user = cached;
    }

    const fresh = await fetchClayUser();
    if (fresh) {
      __cb.userId = fresh.id;
      __cb.user = fresh;
      saveCachedUser(fresh);
      pushUserToSupabase(fresh);
      return fresh;
    }

    return cached || null;
  };

  // Kick off the fetch immediately so __cb.userId is populated as early as
  // possible. Other modules can call ensureUserId() to await it.
  __cb.userIdReady = __cb.ensureUserId();
})();
