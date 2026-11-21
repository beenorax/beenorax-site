const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(data)
});

const base = () =>
  String(process.env.SUPABASE_URL || '').replace(/\/$/, '');

const anon = () => process.env.SUPABASE_ANON_KEY || '';
const service = () => process.env.SUPABASE_SECRET_KEY || '';

const ALLOWED_HOSTS = new Set([
  'beenoraax.netlify.app',
  'beenoraxx.netlify.app'
]);

const getHeader = (headers, name) => {
  const key = Object.keys(headers || {}).find(
    item => item.toLowerCase() === name.toLowerCase()
  );

  return key ? String(headers[key] || '') : '';
};

const isSameOrigin = event => {
  const origin = getHeader(event.headers, 'origin').trim();
  const host = (
    getHeader(event.headers, 'host') ||
    getHeader(event.headers, 'x-forwarded-host')
  ).split(',')[0].trim().toLowerCase();

  // The request must come through one of the approved Beenorax domains.
  if (!host || !ALLOWED_HOSTS.has(host)) {
    return false;
  }

  // Some same-origin GET requests do not include an Origin header.
  // In that case, the approved Host header is used.
  if (!origin) {
    return true;
  }

  try {
    const parsedOrigin = new URL(origin);

    if (parsedOrigin.protocol !== 'https:') {
      return false;
    }

    const originHost = parsedOrigin.host.toLowerCase();

    return (
      ALLOWED_HOSTS.has(originHost) &&
      originHost === host
    );
  } catch {
    return false;
  }
};

const supabaseGet = async path => {
  const response = await fetch(`${base()}/rest/v1/${path}`, {
    headers: {
      apikey: service(),
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Database request failed: ${response.status}`);
  }

  return response.json();
};

exports.handler = async event => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed.' });
  }

  if (!isSameOrigin(event)) {
    return json(403, { error: 'Request origin not allowed.' });
  }

  if (!base() || !anon() || !service()) {
    return json(500, {
      error: 'Server configuration is incomplete.'
    });
  }

  const authorization = getHeader(
    event.headers,
    'authorization'
  );

  const token = authorization
    .replace(/^Bearer\s+/i, '')
    .trim();

  if (!token) {
    return json(401, {
      error: 'Authentication required.'
    });
  }

  try {
    const authResponse = await fetch(
      `${base()}/auth/v1/user`,
      {
        headers: {
          apikey: anon(),
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!authResponse.ok) {
      return json(401, {
        error: 'Your session is invalid or expired.'
      });
    }

    const user = await authResponse.json();

    if (!user.id || !user.email_confirmed_at) {
      return json(403, {
        error: 'Verified email is required.'
      });
    }

    const userId = encodeURIComponent(user.id);

    const profileRows = await supabaseGet(
      `profiles?id=eq.${userId}` +
      `&select=id,full_name,organization,requested_role,role`
    );

    const membershipRows = await supabaseGet(
      `journal_memberships?user_id=eq.${userId}` +
      `&active=eq.true` +
      `&select=id,user_id,journal_code,role,active`
    );

    const profile = profileRows[0] || null;

    return json(200, {
      authenticated: true,

      user: {
        id: user.id,
        email: user.email
      },

      profile,
      memberships: membershipRows,

      access_pending: !profile ||
        (!profile.role && membershipRows.length === 0)
    });

  } catch (error) {
    console.error('Journal access error:', error);

    return json(500, {
      error: 'Unable to verify journal access.'
    });
  }
};
  } catch (error) {
    console.error('Journal access diagnostic:', {
      message: error.message
    });

    return json(500, {
      error: 'Unable to verify journal access.',
      diagnostic_message: error.message
    });
  }
