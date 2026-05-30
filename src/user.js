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
   * { id, email, name, profilePicture, isImpersonated, adminUser } object, or
   * null if the fetch fails.
   *
   * `id` is always a string (Clay returns a numeric id; we stringify so the
   * Supabase `text` column receives a consistent type).
   *
   * When a Clay member is impersonating another user, /v3/me returns the
   * *impersonated* identity at the top level plus `isImpersonated: true` and
   * `adminUser` (the real Clay admin, server-set so trustworthy). We surface
   * both so ensureUserId can attribute activity to the real admin — the
   * extension should know it's you, not the person you're impersonating.
   */
  async function fetchClayUser() {
    try {
      const res = await fetch("https://api.clay.com/v3/me", {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.id == null) return null;
      const admin = data.adminUser || null;
      return {
        id: String(data.id),
        email: data.email || null,
        name: data.fullName || data.name || data.username || data.email || null,
        profilePicture: data.profilePicture || null,
        isImpersonated: data.isImpersonated === true,
        adminUser: admin
          ? {
              id: String(admin.id),
              email: admin.email || null,
              name: admin.fullName || admin.name || admin.email || null,
            }
          : null,
      };
    } catch (err) {
      console.warn("[Clay Scoping] /v3/me fetch failed:", err);
      return null;
    }
  }

  /**
   * Given a fresh /v3/me result, resolve the identity the extension should
   * act AS. Normally that's the user themselves; while impersonating it's the
   * real Clay admin (so writes, presence, and the collaborators widget are
   * attributed to you, not the impersonated user).
   *
   * We try to enrich the admin identity with a previously-cached profile
   * (name + avatar) from when you used the extension as yourself, since
   * /v3/me's `adminUser` payload carries no profile picture. The impersonated
   * user is returned separately as display-only context.
   */
  function resolveActingIdentity(fresh, cached) {
    if (fresh.isImpersonated && fresh.adminUser) {
      const admin = fresh.adminUser;
      const enriched = cached && cached.id === admin.id ? cached : null;
      return {
        acting: {
          id: admin.id,
          email: admin.email || enriched?.email || null,
          name: admin.name || enriched?.name || null,
          profilePicture: enriched?.profilePicture || null,
        },
        impersonating: {
          id: fresh.id,
          email: fresh.email,
          name: fresh.name,
          profilePicture: fresh.profilePicture,
        },
      };
    }
    return {
      acting: {
        id: fresh.id,
        email: fresh.email,
        name: fresh.name,
        profilePicture: fresh.profilePicture,
      },
      impersonating: null,
    };
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
      const { acting, impersonating } = resolveActingIdentity(fresh, cached);
      __cb.userId = acting.id;
      __cb.user = acting;
      __cb.isImpersonating = !!impersonating;
      __cb.impersonatedUser = impersonating;

      // Only persist your real (non-impersonated) identity to localStorage so
      // the cached entry keeps the admin's name + avatar. While impersonating
      // we deliberately don't overwrite it with the impersonated user (or the
      // avatar-less adminUser payload).
      if (!impersonating) saveCachedUser(acting);

      // Re-mint the Supabase JWT if it was minted for a different Clay
      // identity than the one we're now acting as (e.g. the cached JWT predates
      // this build and lacks the is_internal claim, or you switched accounts).
      // Awaited so consumers gated on userIdReady see a JWT whose `sub` matches
      // the rows we're about to write. The `sub` is stable across an
      // impersonation toggle (always the admin), so this won't fire on every
      // start/stop — only on a genuine identity change.
      if (
        __cb.supabaseJwtUserId &&
        __cb.supabaseJwtUserId !== acting.id &&
        __cb.refreshSupabaseJwt
      ) {
        await __cb.refreshSupabaseJwt();
      }

      pushUserToSupabase(acting);
      return acting;
    }

    return cached || null;
  };

  // Kick off the fetch immediately so __cb.userId is populated as early as
  // possible. Other modules can call ensureUserId() to await it.
  __cb.userIdReady = __cb.ensureUserId();
})();
