(() => {
'use strict';
const $ = (s, root=document) => root.querySelector(s);
const page = document.body.dataset.dashboard;
const notice = $('#notice');
const content = $('#content');
const API = '/.netlify/functions/journal-api';
const ADMIN_API = '/.netlify/functions/journal-admin';
let supabase;
let accessToken = '';

function show(message, type='') {
  notice.textContent = message;
  notice.className = 'notice' + (type ? ' ' + type : '');
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function status(value) { return `<span class="status">${esc(String(value || 'pending').replaceAll('_',' '))}</span>`; }
async function token() {
  const {data,error} = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('Your session has expired. Please sign in again.');
  accessToken = data.session.access_token;
  return accessToken;
}
async function request(url, body=null) {
  const t = await token();
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {'Authorization': `Bearer ${t}`, ...(body ? {'Content-Type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new Error(result.error || result.message || `Request failed (${response.status})`);
  return result;
}
function rowsFrom(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
}
async function init() {
  const cfg = window.BEENORAX_AUTH_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey || !window.supabase) {
    show('Authentication configuration is missing. Contact the site administrator.', 'error'); return;
  }
  supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
  });
  $('#signOut')?.addEventListener('click', async () => { await supabase.auth.signOut(); location.href='/journal-access.html'; });
  $('#refresh')?.addEventListener('click', load);
  try {
    await token();
    const access = await request('/.netlify/functions/journal-access');
    if (!access.authenticated) throw new Error('Please sign in to continue.');
    const profileRole = String(access.profile?.role || '').toLowerCase();
    const memberships = access.memberships || [];
    if (page === 'admin' && profileRole !== 'admin') throw new Error('Administrator access is required for this page.');
    if (page === 'author' && !access.user) throw new Error('Please sign in.');
    if (page === 'reviewer' && !memberships.some(m => ['reviewer','journal_reviewer'].includes(String(m.role).toLowerCase()))) {
      throw new Error('No active reviewer membership was found for this account.');
    }
    if (page === 'editor' && !memberships.some(m => ['editor','editor_in_chief','journal_admin','journal_editor'].includes(String(m.role).toLowerCase()))) {
      throw new Error('No active editorial membership was found for this account.');
    }
    show(`Signed in as ${access.profile?.full_name || access.user?.email || 'user'}.`, 'success');
    await load();
  } catch (e) {
    show(e.message, 'error');
    content.innerHTML = `<p class="muted">${esc(e.message)} <a href="/journal-access.html">Go to journal access</a></p>`;
  }
}
async function load() {
  content.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (page === 'author') await loadAuthor();
    if (page === 'reviewer') await loadReviewer();
    if (page === 'editor') await loadEditor();
    if (page === 'admin') await loadAdmin();
  } catch(e) {
    content.innerHTML = `<p class="danger">${esc(e.message)}</p>`;
    show(e.message, 'error');
  }
}
async function loadAuthor() {
  const data = await request(API, {action:'my_submissions'});
  const items = rowsFrom(data,['submissions','data','items']);
  if (!items.length) { content.innerHTML='<p class="muted">You have not submitted any manuscripts yet.</p>'; return; }
  content.innerHTML = `<table><thead><tr><th>Reference</th><th>Manuscript</th><th>Journal</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${items.map(x=>`<tr><td>${esc(x.reference_code || x.id)}</td><td>${esc(x.title)}</td><td>${esc(x.journal_code==='bjbs'?'BBJ':x.journal_code==='bjba'?'BBIJ':x.journal_code)}</td><td>${status(x.status)}</td><td>${esc(x.submitted_at ? new Date(x.submitted_at).toLocaleDateString() : '')}</td></tr>`).join('')}</tbody></table>`;
}
async function loadReviewer() {
  const data = await request(API,{action:'reviewer_queue'});
  const items = rowsFrom(data,['assignments','reviews','data','items']);
  if (!items.length) {content.innerHTML='<p class="muted">There are no review assignments available.</p>';return;}
  content.innerHTML = `<div class="card-grid">${items.map(x=>{
    const s=x.submission || x.journal_submission || {};
    return `<article class="item-card"><h3>${esc(s.title || x.title || 'Assigned manuscript')}</h3><p>Journal: ${esc(s.journal_code || x.journal_code || '')}</p><p>Assignment: ${status(x.status)}</p><p>Reference: ${esc(s.reference_code || s.id || x.submission_id || '')}</p>${s.download_url || x.download_url ? `<p><a target="_blank" rel="noopener" href="${esc(s.download_url || x.download_url)}">Download manuscript</a></p>`:''}<form class="review-form" data-assignment="${esc(x.id)}"><div class="field"><label>Recommendation</label><select name="recommendation" required><option value="">Choose</option><option value="accept">Accept</option><option value="minor_revision">Minor revision</option><option value="major_revision">Major revision</option><option value="reject">Reject</option></select></div><div class="field"><label>Comments for author</label><textarea name="author_comments" required></textarea></div><div class="field"><label>Confidential comments to editor</label><textarea name="confidential_comments"></textarea></div><div class="actions"><button class="button" type="submit">Submit review</button></div></form></article>`;
  }).join('')}</div>`;
  content.querySelectorAll('.review-form').forEach(form=>form.addEventListener('submit',submitReview));
}
async function submitReview(e) {
  e.preventDefault(); const f=e.currentTarget; const fd=new FormData(f);
  try {
    await request(API,{action:'submit_review',assignment_id:f.dataset.assignment,recommendation:fd.get('recommendation'),author_comments:fd.get('author_comments'),confidential_comments:fd.get('confidential_comments')});
    show('Review submitted successfully.','success'); await load();
  } catch(err){show(err.message,'error');}
}
async function loadEditor() {
  const data = await request(API,{action:'editor_queue'});
  const items = rowsFrom(data,['submissions','queue','data','items']);
  if (!items.length) {content.innerHTML='<p class="muted">There are no manuscripts in your editorial queue.</p>';return;}
  const reviewersData = await request(API,{action:'list_reviewers'});
  const reviewers = rowsFrom(reviewersData,['reviewers','data','items']);
  content.innerHTML = `<table><thead><tr><th>Manuscript</th><th>Journal</th><th>Status</th><th>File</th><th>Editorial actions</th></tr></thead><tbody>${items.map(s=>`<tr><td><strong>${esc(s.title)}</strong><br><span class="small muted">${esc(s.reference_code || s.id)}</span></td><td>${esc(s.journal_code)}</td><td>${status(s.status)}</td><td>${s.download_url?`<a target="_blank" rel="noopener" href="${esc(s.download_url)}">Download</a>`:'Not available'}</td><td><form class="assign-form" data-submission="${esc(s.id)}"><div class="field"><label>Assign reviewer ID</label><input name="reviewer_id" required placeholder="Reviewer UUID"></div><button class="button button-outline" type="submit">Assign reviewer</button></form><form class="decision-form" data-submission="${esc(s.id)}"><div class="field"><label>Decision</label><select name="decision"><option value="under_review">Under review</option><option value="minor_revision">Minor revision</option><option value="major_revision">Major revision</option><option value="accepted">Accept</option><option value="rejected">Reject</option></select></div><div class="field"><label>Decision note</label><textarea name="decision_note"></textarea></div><button class="button" type="submit">Save decision</button></form></td></tr>`).join('')}</tbody></table><p class="muted small">Reviewer IDs are used because the current API returns reviewer identifiers, not private email addresses.</p>`;
  content.querySelectorAll('.assign-form').forEach(f=>f.addEventListener('submit',assignReviewer));
  content.querySelectorAll('.decision-form').forEach(f=>f.addEventListener('submit',saveDecision));
}
async function assignReviewer(e){e.preventDefault();const f=e.currentTarget;try{await request(API,{action:'assign_reviewer',submission_id:f.dataset.submission,reviewer_id:new FormData(f).get('reviewer_id')});show('Reviewer assignment created.','success');await load();}catch(err){show(err.message,'error');}}
async function saveDecision(e){e.preventDefault();const f=e.currentTarget;const d=new FormData(f);try{await request(API,{action:'decision',submission_id:f.dataset.submission,decision:d.get('decision'),decision_note:d.get('decision_note')});show('Editorial decision saved.','success');await load();}catch(err){show(err.message,'error');}}
async function loadAdmin() {
  const data=await request(ADMIN_API);
  const users=rowsFrom(data,['profiles','users','data']);
  const memberships=rowsFrom(data,['memberships']);
  if(!users.length){content.innerHTML='<p class="muted">No user profiles were returned.</p>';return;}
  content.innerHTML=`<table><thead><tr><th>User</th><th>Organisation</th><th>Requested role</th><th>Platform role</th><th>Journal memberships</th><th>Grant membership</th></tr></thead><tbody>${users.map(u=>{
    const ms=memberships.filter(m=>m.user_id===u.id);
    return `<tr><td><strong>${esc(u.full_name || 'Unnamed user')}</strong><br><span class="small muted">${esc(u.id)}</span></td><td>${esc(u.organization)}</td><td>${esc(u.requested_role)}</td><td>${esc(u.role)}</td><td>${ms.map(m=>`${esc(m.journal_code)}: ${esc(m.role)} (${m.active?'active':'inactive'})`).join('<br>') || 'None'}</td><td><form class="membership-form" data-user="${esc(u.id)}"><div class="field"><label>Journal</label><select name="journal_code"><option value="bjbs">BBJ</option><option value="bjba">BBIJ</option></select></div><div class="field"><label>Role</label><select name="role"><option value="reviewer">Reviewer</option><option value="editor">Editor</option><option value="editor_in_chief">Editor-in-Chief</option><option value="journal_admin">Journal administrator</option></select></div><button class="button" type="submit">Save membership</button></form></td></tr>`;
  }).join('')}</tbody></table><p class="small muted">Only assign roles that have been approved and are supported by your configured backend role rules. This tool does not create platform administrators.</p>`;
  content.querySelectorAll('.membership-form').forEach(f=>f.addEventListener('submit',saveMembership));
}
async function saveMembership(e){e.preventDefault();const f=e.currentTarget,d=new FormData(f);try{await request(ADMIN_API,{action:'set_membership',user_id:f.dataset.user,journal_code:d.get('journal_code'),role:d.get('role'),active:true});show('Membership saved.','success');await load();}catch(err){show(err.message,'error');}}
document.addEventListener('DOMContentLoaded',init);
})();