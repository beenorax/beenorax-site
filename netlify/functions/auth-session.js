const out = (statusCode, data, extraHeaders = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  body: JSON.stringify(data)
});

exports.handler = async (event) => {
  const origin = event.headers?.origin;
  const host = event.headers?.host;
  if (origin && host) {
    try { if (new URL(origin).host !== host) return out(403, { error: 'origin_not_allowed' }); }
    catch { return out(403, { error: 'origin_not_allowed' }); }
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Cache-Control': 'no-store' } };
  if (event.httpMethod !== 'POST') return out(405, { error: 'method' });
  const cookieBase = 'Path=/; HttpOnly; Secure; SameSite=Lax';
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return out(400, { error: 'bad_json' }, headers); }
  if (body.clear === true) return out(200, { ok: true }, { 'Set-Cookie': `beenorax_access_token=; ${cookieBase}; Max-Age=0` });
  const token = typeof body.access_token === 'string' ? body.access_token : '';
  if (!token || token.length > 5000) return out(400, { error: 'missing_token' });
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return out(503, { error: 'auth_not_configured' });
  try {
    const verify = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` }
    });
    if (!verify.ok) return out(401, { error: 'invalid_session' });
    return out(200, { ok: true }, { 'Set-Cookie': `beenorax_access_token=${token}; ${cookieBase}; Max-Age=3600` });
  } catch {
    return out(503, { error: 'auth_unavailable' });
  }
};
