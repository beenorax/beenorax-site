function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  const origin = request.headers.get('Origin');
  const host = request.headers.get('Host');

  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return json(403, { error: 'origin_not_allowed' });
      }
    } catch {
      return json(403, { error: 'origin_not_allowed' });
    }
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'method' });
  }

  const cookieBase =
    'Path=/; HttpOnly; Secure; SameSite=Lax';

  let body;

  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'bad_json' });
  }

  if (body.clear === true) {
    return json(
      200,
      { ok: true },
      {
        'Set-Cookie':
          `beenorax_access_token=; ${cookieBase}; Max-Age=0`
      }
    );
  }

  const token =
    typeof body.access_token === 'string'
      ? body.access_token
      : '';

  if (!token || token.length > 5000) {
    return json(400, { error: 'missing_token' });
  }

  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;

  if (!url || !anon) {
    return json(503, { error: 'auth_not_configured' });
  }

  try {
    const verify = await fetch(
      `${url.replace(/\/$/, '')}/auth/v1/user`,
      {
        headers: {
          apikey: anon,
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!verify.ok) {
      return json(401, { error: 'invalid_session' });
    }

    return json(
      200,
      { ok: true },
      {
        'Set-Cookie':
          `beenorax_access_token=${token}; ${cookieBase}; Max-Age=3600`
      }
    );

  } catch {
    return json(503, { error: 'auth_unavailable' });
  }
}
