BEENORAX JOURNAL DASHBOARD PACKAGE

This package contains the remaining dashboard files and a completed author dashboard.

UPLOAD DESTINATIONS
- author-dashboard.html                 -> repository root
- reviewer-dashboard.html               -> repository root
- editor-dashboard.html                 -> repository root
- admin-dashboard.html                  -> repository root
- asset/journal.css                     -> asset/
- asset/journal-dashboard.js            -> asset/
- netlify/functions/journal-admin.js    -> netlify/functions/

KEEP THESE EXISTING FILES
- asset/auth-config.js
- journal-access.html
- netlify/functions/journal-access.js
- netlify/functions/journal-api.js
- netlify/functions/auth-session.js
- manuscript.html
- journal.html
- publishing-policies.html

IMPORTANT CONFIGURATION
1. The pages expect the existing browser config at /asset/auth-config.js.
2. The admin function expects Netlify environment variables:
   SUPABASE_URL
   SUPABASE_ANON_KEY
   SUPABASE_SECRET_KEY
3. Platform administrator access is currently restricted to profiles.role = 'admin'.
   Confirm that this is the exact administrator value in your database before use.
4. The membership form uses role values reviewer, editor, editor_in_chief and journal_admin.
   Confirm these values match the role checks in your existing journal-api.js before assigning memberships.
5. The API action names and payloads used by the dashboards are:
   my_submissions
   reviewer_queue
   editor_queue
   list_reviewers
   submit_review
   assign_reviewer
   decision
   Confirm your current journal-api.js accepts these exact action and field names.
6. The reviewer dashboard submits recommendation values:
   accept, minor_revision, major_revision, reject.
   Confirm the backend accepts these values.
7. The editor decision form submits:
   under_review, minor_revision, major_revision, accepted, rejected.
   Confirm the backend accepts these exact values. If the backend uses different values, update the dropdown values to match it.
8. The editor dashboard currently accepts reviewer UUID entry because the existing reviewer-list action returns IDs only.
9. The admin function only creates or updates journal_memberships. It does not create platform admins, alter profiles.role, or change database schema.
10. No database migrations are included. Existing journal codes bjbs and bjba are retained.

SECURITY / RELEASE NOTES
- Do not put SUPABASE_SECRET_KEY in browser JavaScript.
- The admin function checks the authenticated user against profiles.role before allowing access.
- Existing API endpoints must independently enforce permissions. Hiding dashboard pages is not a security boundary.
- Before accepting live manuscripts, test login, verified-email handling, storage upload, author listing, reviewer assignment, review submission, editor decisions and article publication with test accounts.
- The backend currently performs some multi-step writes as separate requests. Confirm transaction/consistency safeguards before production use.
- The package does not open formal submissions or claim ISSN, DOI registration, indexing, accreditation or peer-review operations are complete.
