BEENORAX ANALYTICS & CONSULTING
Final website package with registered Analytics Workspace access

Files include:
- index.html: public company website
- workspace.html: Analytics Workspace (protected by Netlify Edge Function)
- access.html: registration and login
- reset-password.html: password reset completion
- asset/auth-config.js: public Supabase URL and anon key placeholders
- netlify/functions/auth-session.js: creates/clears the secure HttpOnly workspace session cookie
- netlify/functions/admin-users.js: server-side administrator user management
- netlify/functions/bena.js: BENA AI Gemini integration
- netlify/edge-functions/workspace-guard.ts: protects workspace.html
- supabase-setup.sql: profile table, signup trigger and row-level security
- AUTHENTICATION-SETUP.md: full setup instructions

IMPORTANT: This package is not ready for production authentication until a Supabase project is created, asset/auth-config.js is configured, the SQL is run, and the three SUPABASE_* Netlify environment variables are set. Configure GEMINI_API_KEY in Netlify for BENA AI. Never place SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY in frontend files or GitHub.

Deploy the extracted folder contents to the root of the new GitHub repository. Connect that repository to Netlify. Netlify publish directory: . ; functions directory: netlify/functions. The edge function is declared in netlify.toml.
