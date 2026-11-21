const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(data)
});

const base = () => String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const service = () => process.env.SUPABASE_SECRET_KEY;
const anon = () => process.env.SUPABASE_ANON_KEY;

// Administrative requests use the secret key in the apikey header only.
// New Supabase secret keys are not JWTs.
async function request(path, options = {}) {
  return fetch(`${base()}${path}`, {
    ...options,
    headers: {
      apikey: service(),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

// Verify the signed-in user's actual Supabase session.
async function requireAdmin(event) {
  const auth =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    '';

  const token = auth.replace(/^Bearer\s+/i, '');

  if (!token || !base() || !service() || !anon()) {
    return null;
  }

  const verified = await fetch(`${base()}/auth/v1/user`, {
    headers: {
      apikey: anon(),
      Authorization: `Bearer ${token}`
    }
  });

  if (!verified.ok) return null;

  const user = await verified.json();

  const profileRes = await request(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`
  );

  if (!profileRes.ok) return null;

  const profiles = await profileRes.json();

  return profiles[0]?.role === 'admin' ? user : null;
}

exports.handler = async (event) => {
  if (!['GET', 'PATCH'].includes(event.httpMethod)) {
    return json(405, { error: 'method' });
  }

  if (!base() || !service() || !anon()) {
    return json(503, { error: 'auth_not_configured' });
  }

  let admin;

  try {
    admin = await requireAdmin(event);
  } catch {
    return json(503, { error: 'auth_unavailable' });
  }

  if (!admin) {
    return json(403, { error: 'admin_only' });
  }

  // Retrieve registered users.
  if (event.httpMethod === 'GET') {
    try {
      const [usersRes, profilesRes] = await Promise.all([
        request('/auth/v1/admin/users?page=1&per_page=200'),
        request(
          '/rest/v1/profiles?select=id,full_name,organization,role,requested_role,created_at&order=created_at.desc'
        )
      ]);

      if (!usersRes.ok || !profilesRes.ok) {
        return json(502, { error: 'user_list_failed' });
      }

      const users = await usersRes.json();
      const profiles = await profilesRes.json();

      const byId = new Map(profiles.map(p => [p.id, p]));

      return json(200, {
        users: (users.users || []).map(u => ({
          id: u.id,
          email: u.email,
          emailConfirmed: !!u.email_confirmed_at,
          lastSignIn: u.last_sign_in_at || null,
          bannedUntil: u.banned_until || null,
          createdAt: u.created_at,
          ...(byId.get(u.id) || {
            role: 'general_user',
            full_name: '',
            organization: ''
          })
        }))
      });

    } catch {
      return json(502, { error: 'user_list_failed' });
    }
  }

  // Process administrative updates.
  let body;

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const { userId, role, suspended } = body;

  const allowed = [
    'admin',
    'researcher',
    'student',
    'business_analyst',
    'general_user'
  ];

  if (
    typeof userId !== 'string' ||
    userId.length > 100 ||
    (role !== undefined && !allowed.includes(role)) ||
    (suspended !== undefined && typeof suspended !== 'boolean')
  ) {
    return json(400, { error: 'invalid_input' });
  }

  if (userId === admin.id) {
    return json(400, { error: 'self_management_disabled' });
  }

  try {
    // Update user role.
    if (role !== undefined) {
      const update = await request(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ role })
        }
      );

      if (!update.ok) {
        return json(502, { error: 'role_update_failed' });
      }
    }

    // Suspend or restore user account.
    if (suspended !== undefined) {
      const update = await request(
        `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            ban_duration: suspended ? '876000h' : 'none'
          })
        }
      );

      if (!update.ok) {
        return json(502, { error: 'status_update_failed' });
      }
    }

    return json(200, { ok: true });

  } catch {
    return json(502, { error: 'update_failed' });
  }
};
