export default async (request: Request, context: any) => {
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)beenorax_access_token=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : '';
  if (url && anon && token) {
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
        headers: { apikey: anon, Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const user = await response.json();
        const verified = !!user.email_confirmed_at;
        const banned = user.banned_until && new Date(user.banned_until).getTime() > Date.now();
        if (verified && !banned) return context.next();
      }
    } catch (_) {}
  }
  const destination = new URL('/access.html', request.url);
  destination.searchParams.set('next', '/workspace.html');
  return Response.redirect(destination, 302);
};
