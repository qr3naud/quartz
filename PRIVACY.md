# Quartz — Privacy Policy

_Last updated: 2026-06-17_

Quartz is an internal Chrome extension for Clay's go-to-market team. It adds a
visual scoping canvas to Clay workbooks (app.clay.com) for planning enrichment
workflows. This policy explains what data the extension touches and why.

## Summary

- Quartz is used by signed-in Clay users on app.clay.com.
- It does **not** sell your data, show ads, or use third-party analytics or
  tracking.
- The only personal data it handles is what's required to authenticate you to
  Clay and to save your scoping canvases.

## What data is handled, and why

### Clay session cookies (authentication)

To act on your behalf, Quartz needs to confirm you are a logged-in Clay user.
The extension reads your `api.clay.com` session cookie and sends it **once per
session** to a Clay-operated backend function, which validates it against
Clay's own API and returns a short-lived (1 hour) signed token. That token is
then used to authorize the extension's own backend requests.

- The cookie is read only to mint the token; it is **not stored, logged, or
  persisted** by the extension's backend.
- The `cookies` permission is required because session cookies are HttpOnly and
  cannot be read by ordinary page scripts.

### Scoping canvases and related metadata (functionality)

The canvases you create — enrichment plans, notes, cost estimates, and the
associated Clay workbook/workspace identifiers — are stored in a Clay-operated
Supabase database so they sync across your devices and collaborators. Access is
restricted by row-level security to the Clay workspaces you belong to.

### Data Quartz does **not** collect

- No browsing history outside app.clay.com.
- No analytics, advertising, or behavioral tracking.
- No sale or transfer of data to third parties for unrelated purposes.

## Permissions

| Permission | Why it's needed |
|---|---|
| `cookies` | Read the HttpOnly `api.clay.com` session cookie to authenticate you to Clay. |
| `activeTab` / host access to `app.clay.com` | Inject the scoping canvas UI into Clay workbooks. |
| `storage` | Cache your short-lived auth token and local UI preferences. |
| Host access to Clay/Supabase/S3/Google Docs endpoints | Save and load canvases, fetch pricing data, and open exported documents. |

## Data retention

- The auth token is short-lived (1 hour) and refreshed as needed.
- Canvases persist until you or your workspace delete them.

## Contact

Questions about this policy or your data: **friends@clay.run**

## Changes

Material changes to this policy will be reflected by updating the date at the
top of this document.
