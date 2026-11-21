const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};
const response = (statusCode, data) => ({ statusCode, headers, body: JSON.stringify(data) });
const base = () => String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const anon = () => process.env.SUPABASE_ANON_KEY || '';
const secret = () => process.env.SUPABASE_SECRET_KEY || '';

async function supabase(path, options = {}) {
  const key = secret();
  if (!base() || !key) throw new Error('Supabase server configuration is incomplete.');
  const res = await fetch(`${base()}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) throw new Error(data?.message || data?.hint || 'Database request failed.');
  return data;
}
async function authenticate(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Authentication required.');
  const res = await fetch(`${base()}/auth/v1/user`, {
    headers: { apikey: anon(), Authorization: `Bearer ${match[1]}` }
  });
  if (!res.ok) throw new Error('Your session is invalid or expired.');
  const user = await res.json();
  if (!user.email_confirmed_at) throw new Error('Please verify your email address.');
  const profiles = await supabase(`profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role&limit=1`);
  if (!profiles?.length || String(profiles[0].role || '').toLowerCase() !== 'admin') {
    throw new Error('Platform administrator access is required.');
  }
  return user;
}
function sameOrigin(event) {
  const origin = event.headers.origin;
  const host = event.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch (_) { return false; }
}
exports.handler = async (event) => {
  if (!['GET','POST'].includes(event.httpMethod)) return response(405,{error:'Method not allowed.'});
  if (!sameOrigin(event)) return response(403,{error:'Request origin is not permitted.'});
  try {
    await authenticate(event);
    if (event.httpMethod === 'GET') {
      const [profiles, memberships] = await Promise.all([
        supabase('profiles?select=id,full_name,organization,requested_role,role,created_at&order=created_at.desc'),
        supabase('journal_memberships?select=id,user_id,journal_code,role,active,created_at&order=created_at.desc')
      ]);
      return response(200,{profiles,memberships});
    }
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return response(400,{error:'Invalid JSON body.'}); }
    if (body.action !== 'set_membership') return response(400,{error:'Unsupported administrative action.'});
    const userId = String(body.user_id || '');
    const journalCode = String(body.journal_code || '');
    const role = String(body.role || '').toLowerCase();
    const active = body.active === true;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const allowedRoles = ['reviewer','editor','editor_in_chief','journal_admin'];
    if (!uuid.test(userId) || !['bjbs','bjba'].includes(journalCode) || !allowedRoles.includes(role)) {
      return response(400,{error:'Invalid user, journal or membership role.'});
    }
    const existing = await supabase(`journal_memberships?user_id=eq.${encodeURIComponent(userId)}&journal_code=eq.${journalCode}&role=eq.${role}&select=id&limit=1`);
    let result;
    if (existing?.length) {
      result = await supabase(`journal_memberships?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method:'PATCH', body:JSON.stringify({active}), prefer:'return=representation'
      });
    } else {
      result = await supabase('journal_memberships', {
        method:'POST', body:JSON.stringify({user_id:userId,journal_code:journalCode,role,active}), prefer:'return=representation'
      });
    }
    return response(200,{success:true,membership:result?.[0] || null});
  } catch (error) {
    return response(403,{error:error.message || 'Administrative request failed.'});
  }
};