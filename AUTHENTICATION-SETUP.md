# Beenorax registration and workspace authentication

The main website remains public. `/workspace.html` is protected by a Netlify Edge Function and requires a verified Supabase Auth session. Registration is open; every new account receives the `general_user` role. The requested account type is stored separately and cannot grant privileges. An administrator assigns the effective role.

## 1. Create the Supabase project

1. Create a Supabase project using the dedicated Beenorax business email.
2. In Authentication → Providers → Email, enable email confirmations.
3. In Authentication → URL Configuration, set the Site URL to the production Netlify URL.
4. Add these Redirect URLs (replace with the real production URL and any test deploy URL):
   - `https://YOUR-SITE.netlify.app/access.html`
   - `https://YOUR-SITE.netlify.app/reset-password.html`
5. Open SQL Editor and run `supabase-setup.sql` from this package.

## 2. Configure the browser client

Edit `asset/auth-config.js` and replace:
- `https://YOUR_PROJECT_REF.supabase.co` with the Supabase Project URL.
- `YOUR_SUPABASE_ANON_KEY` with the Supabase publishable/anon key.

The anon key is intended for browser use. **Never place the service-role key in this file or in GitHub.**

## 3. Configure Netlify environment variables

In the new Netlify site, add these variables under Site configuration → Environment variables, then redeploy:

- `SUPABASE_URL` = Supabase Project URL
- `SUPABASE_ANON_KEY` = Supabase publishable/anon key
- `SUPABASE_SERVICE_ROLE_KEY` = Supabase service-role/secret key (server-side only)
- `GEMINI_API_KEY` = existing Gemini API key for BENA AI
- `GEMINI_MODEL` = optional supported Gemini model name

Do not commit any secret values to GitHub. The public anon key is also configured in `asset/auth-config.js` because the browser SDK needs it.

## 4. Promote the first administrator

1. Register the intended Beenorax administrator through `/access.html`.
2. Verify that email address using the confirmation email.
3. In Supabase SQL Editor, run the following command after replacing the email address:

```sql
update public.profiles
set role = 'admin'
where id = (
  select id from auth.users
  where lower(email) = lower('ADMIN_EMAIL@example.com')
);
```

4. Sign out and sign back in. The Administrator: User Management panel will appear inside the workspace.

Do not make public registration automatically assign the admin role. The profile trigger always assigns `general_user`, regardless of the requested account type.

## 5. Administrator features

The protected admin function verifies the caller's Supabase JWT and checks the caller's `profiles.role` on the server before allowing account management. Administrators can:
- Review the latest 200 accounts.
- See email verification status.
- Assign `admin`, `researcher`, `student`, `business_analyst`, or `general_user` roles.
- Suspend or restore another account.

An administrator cannot change their own role or suspend their own account through this interface. Supabase handles confirmation and password-reset emails. The password reset page is `/reset-password.html`.

## 6. Important deployment checks

- Confirm the Netlify deploy includes `netlify/edge-functions/workspace-guard.ts` and the `[[edge_functions]]` entry in `netlify.toml`.
- Confirm `/workspace.html` redirects to `/access.html` when signed out.
- Confirm registration sends a verification email and unverified accounts cannot enter the workspace.
- Confirm password reset works from the email link.
- Confirm an ordinary user cannot call the admin endpoint successfully.
- Confirm the first administrator can list users, change another user's role, suspend and restore a test account.
- Confirm BENA AI works after `GEMINI_API_KEY` is configured.

The workspace's analytical calculations remain browser-side. Authentication controls entry to the workspace interface; it does not make static front-end source code confidential. User datasets are not stored by this authentication layer. Do not upload identifiable patient or confidential data unless the appropriate legal, ethical, and organisational controls are in place.
