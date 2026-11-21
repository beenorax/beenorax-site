# Beenorax Journal Publishing Module

## Included
- `publications.html`: public portal for both journals.
- `journal.html?journal=bjbs` and `journal.html?journal=bjba`: separate journal homepages.
- `manuscript.html`: authenticated author submission form.
- `editorial.html`: restricted editorial queue and decision interface.
- `reviewer.html`: reviewer queue and confidential review submission form.
- `publishing-policies.html`: baseline publishing policies.
- `netlify/functions/journal-api.js`: server-side authenticated submission/editorial API.
- `supabase-setup.sql`: journal tables, RLS, private manuscript bucket and upload policies.

## Journal names and internal codes
- **BJBS**: Beenorax Journal of Biomedical Sciences (`bjbs`).
- **BJBA**: Beenorax Journal of Business Analytics (`bjba`).

The short codes are used internally in URLs, submissions and journal-specific permissions.

## Netlify environment variables
Configure these in Netlify (never commit secret values):
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; never expose in browser)

The existing `asset/auth-config.js` must be filled with the Supabase project URL and public anon key.

## Supabase setup
1. Create the Supabase project.
2. Run the complete `supabase-setup.sql` in SQL Editor. It creates the account profiles, journal membership and editorial workflow tables, public article metadata access, and private manuscript storage bucket.
3. Configure Auth email verification and password reset redirect URLs for the deployed domain.
4. Create the initial administrator account using the public registration page, verify the email, then promote the account to `admin` in the Supabase SQL editor after checking the account UUID.
5. Appoint journal editors and reviewers by inserting rows into `journal_memberships` for the relevant journal code. Each journal must have its own Editor-in-Chief. A user may hold roles in one or both journals only if separately appointed.
6. Set Netlify environment variables and deploy.

## Editorial workflow status
The current interface supports author submission and status tracking, journal-specific editor queues and decisions, reviewer queues and review submission, and publication of accepted manuscripts through the server API. Reviewer appointment and manuscript assignment are currently performed by an authorised administrator/editor through the Supabase membership and assignment tables/API setup, not through a polished reviewer-management screen. Revision-file resubmission, DOI registration and Crossref deposit, issue/volume management, automated PDF typesetting and email notification workflows are not yet enabled. These require additional implementation and operational policies before the journals can claim a fully automated production system.

## Launch safeguards
- Do not advertise either journal as indexed, ISSN-registered or DOI-issuing until those services are actually obtained.
- Publish final journal-specific author instructions, review model, ethics policies, copyright/licensing terms, fees (if any), archiving and complaints process before opening formal submissions.
- Editorial roles must be assigned independently for each journal.
