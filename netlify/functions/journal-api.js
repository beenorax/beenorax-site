const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(data)
});

const base = () => String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const anon = () => process.env.SUPABASE_ANON_KEY || '';
const service = () => process.env.SUPABASE_SECRET_KEY || '';

// Use the new secret key through the apikey header only.
async function rest(path, options = {}) {
  return fetch(base() + path, {
    ...options,
    headers: {
      apikey: service(),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

// Verify the user's actual Supabase session.
async function authenticate(event) {
  const h = event.headers?.authorization ||
            event.headers?.Authorization || '';

  const token = h.replace(/^Bearer\s+/i, '');

  if (!token || !base() || !anon() || !service()) return null;

  const r = await fetch(base() + '/auth/v1/user', {
    headers: {
      apikey: anon(),
      Authorization: 'Bearer ' + token
    }
  });

  if (!r.ok) return null;

  const user = await r.json();

  if (!user.email_confirmed_at) return null;

  return user;
}

async function membership(userId, journalCode, roles) {
  const q = `/rest/v1/journal_memberships?user_id=eq.${encodeURIComponent(userId)}&journal_code=eq.${encodeURIComponent(journalCode)}&active=eq.true&select=role`;

  const r = await rest(q);

  if (!r.ok) return false;

  const rows = await r.json();

  return rows.some(x => roles.includes(x.role));
}

async function platformAdmin(userId) {
  const r = await rest(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role&limit=1`
  );

  if (!r.ok) return false;

  const a = await r.json();

  return a[0]?.role === 'admin';
}

async function bodyOf(e) {
  try {
    return JSON.parse(e.body || '{}');
  } catch {
    return null;
  }
}

// Generate a temporary manuscript download URL.
async function signedDownload(filePath) {
  const r = await fetch(
    base() + '/storage/v1/object/sign/journal-manuscripts/' + filePath,
    {
      method: 'POST',
      headers: {
        apikey: service(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: 600 })
    }
  );

  if (!r.ok) return null;

  const d = await r.json();

  return base() + '/storage/v1' + d.signedURL;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  if (!base() || !anon() || !service()) {
    return json(503, {
      error: 'publishing_service_not_configured'
    });
  }

  let user;

  try {
    user = await authenticate(event);
  } catch {
    return json(503, { error: 'authentication_unavailable' });
  }

  if (!user) {
    return json(401, { error: 'verified_login_required' });
  }

  const b = await bodyOf(event);

  if (!b || typeof b.action !== 'string') {
    return json(400, { error: 'invalid_request' });
  }

  const action = b.action;

  try {

    // 1. MANUSCRIPT SUBMISSION
    if (action === 'submit') {
      const code = b.journal_code;

      if (
        !['bjbs', 'bjba'].includes(code) ||
        typeof b.title !== 'string' ||
        b.title.trim().length < 8 ||
        b.title.length > 300 ||
        typeof b.authors_text !== 'string' ||
        b.authors_text.length > 5000 ||
        typeof b.abstract !== 'string' ||
        b.abstract.trim().length < 30 ||
        b.abstract.length > 5000 ||
        typeof b.file_path !== 'string' ||
        !b.file_path.startsWith(user.id + '/') ||
        typeof b.file_name !== 'string' ||
        !(/\.(pdf|docx)$/i).test(b.file_name)
      ) {
        return json(400, {
          error: 'invalid_submission_fields'
        });
      }

      const reference =
        'BNX-' + code.toUpperCase() + '-' +
        Date.now().toString(36).toUpperCase();

      const r = await rest('/rest/v1/journal_submissions', {
        method: 'POST',
        headers: {
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          reference_code: reference,
          journal_code: code,
          author_id: user.id,
          title: b.title.trim(),
          authors_text: b.authors_text,
          abstract: b.abstract,
          keywords: Array.isArray(b.keywords)
            ? b.keywords.slice(0, 20)
            : [],
          file_path: b.file_path,
          file_name: b.file_name,
          status: 'submitted'
        })
      });

      if (!r.ok) {
        return json(502, {
          error: 'submission_save_failed'
        });
      }

      const rows = await r.json();

      return json(201, {
        submission: {
          id: rows[0].id,
          reference_code: reference,
          status: 'submitted'
        }
      });
    }

    // 2. AUTHOR SUBMISSION HISTORY
    if (action === 'my_submissions') {
      const r = await rest(
        `/rest/v1/journal_submissions?author_id=eq.${encodeURIComponent(user.id)}&select=id,reference_code,journal_code,title,status,submitted_at&order=submitted_at.desc`
      );

      if (!r.ok) {
        return json(502, {
          error: 'submission_list_failed'
        });
      }

      return json(200, {
        submissions: await r.json()
      });
    }

    // 3. EDITOR QUEUE
    if (action === 'editor_queue') {
      const isAdmin = await platformAdmin(user.id);

      let codes = [];

      if (isAdmin) {
        codes = ['bjbs', 'bjba'];
      } else {
        const r = await rest(
          `/rest/v1/journal_memberships?user_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=journal_code,role`
        );

        if (!r.ok) {
          return json(502, {
            error: 'membership_lookup_failed'
          });
        }

        codes = (await r.json())
          .filter(x =>
            ['editor_in_chief', 'associate_editor', 'journal_admin']
              .includes(x.role)
          )
          .map(x => x.journal_code);
      }

      if (!codes.length) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      const r = await rest(
        `/rest/v1/journal_submissions?journal_code=in.(${codes.join(',')})&status=not.in.(published,withdrawn)&select=id,reference_code,journal_code,title,abstract,status,file_path,submitted_at&order=submitted_at.asc`
      );

      if (!r.ok) {
        return json(502, {
          error: 'editor_queue_failed'
        });
      }

      const rows = await r.json();

      for (const row of rows) {
        row.download_url = await signedDownload(row.file_path);
      }

      return json(200, {
        submissions: rows
      });
    }

    // 4. REVIEWER QUEUE
    if (action === 'reviewer_queue') {
      const r = await rest(
        `/rest/v1/journal_reviewer_assignments?reviewer_id=eq.${encodeURIComponent(user.id)}&select=id,submission_id,status,journal_submissions(id,reference_code,journal_code,title,abstract,status,file_path)&order=created_at.desc`
      );

      if (!r.ok) {
        return json(502, {
          error: 'reviewer_queue_failed'
        });
      }

      const assignments = await r.json();

      for (const a of assignments) {
        const s = a.journal_submissions;

        if (s?.file_path) {
          a.download_url = await signedDownload(s.file_path);
        }
      }

      return json(200, {
        assignments
      });
    }

    // 5. LIST JOURNAL REVIEWERS
    if (action === 'list_reviewers') {
      if (!['bjbs', 'bjba'].includes(b.journal_code)) {
        return json(400, {
          error: 'invalid_journal'
        });
      }

      if (
        !(await platformAdmin(user.id)) &&
        !(await membership(
          user.id,
          b.journal_code,
          ['editor_in_chief', 'associate_editor', 'journal_admin']
        ))
      ) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      const mr = await rest(
        `/rest/v1/journal_memberships?journal_code=eq.${b.journal_code}&role=eq.reviewer&active=eq.true&select=user_id`
      );

      if (!mr.ok) {
        return json(502, {
          error: 'reviewer_list_failed'
        });
      }

      const ids = (await mr.json()).map(x => x.user_id);

      if (!ids.length) {
        return json(200, { reviewers: [] });
      }

      const ur = await fetch(
        base() + '/auth/v1/admin/users?page=1&per_page=200',
        {
          headers: {
            apikey: service()
          }
        }
      );

      if (!ur.ok) {
        return json(502, {
          error: 'reviewer_account_lookup_failed'
        });
      }

      const users = await ur.json();

      return json(200, {
        reviewers: (users.users || [])
          .filter(x => ids.includes(x.id))
          .map(x => ({
            id: x.id,
            email: x.email
          }))
      });
    }

    // 6. SUBMIT PEER REVIEW
    if (action === 'submit_review') {
      if (
        typeof b.assignment_id !== 'string' ||
        !['accept', 'minor_revision', 'major_revision', 'reject']
          .includes(b.recommendation) ||
        typeof b.author_comments !== 'string' ||
        b.author_comments.length > 8000 ||
        typeof b.confidential_comments !== 'string' ||
        b.confidential_comments.length > 8000
      ) {
        return json(400, {
          error: 'invalid_review'
        });
      }

      const q = await rest(
        `/rest/v1/journal_reviewer_assignments?id=eq.${encodeURIComponent(b.assignment_id)}&reviewer_id=eq.${encodeURIComponent(user.id)}&select=id,status,submission_id`
      );

      if (!q.ok) {
        return json(502, {
          error: 'assignment_lookup_failed'
        });
      }

      const rows = await q.json();

      if (!rows.length) {
        return json(403, {
          error: 'review_assignment_required'
        });
      }

      const a = rows[0];

      if (a.status === 'completed') {
        return json(409, {
          error: 'review_already_completed'
        });
      }

      const ins = await rest('/rest/v1/journal_reviews', {
        method: 'POST',
        body: JSON.stringify({
          assignment_id: a.id,
          recommendation: b.recommendation,
          author_comments: b.author_comments,
          confidential_comments: b.confidential_comments
        })
      });

      if (!ins.ok) {
        return json(502, {
          error: 'review_save_failed'
        });
      }

      const update = await rest(
        `/rest/v1/journal_reviewer_assignments?id=eq.${encodeURIComponent(a.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'completed'
          })
        }
      );

      if (!update.ok) {
        return json(502, {
          error: 'review_status_update_failed'
        });
      }

      return json(200, { ok: true });
    }

    // 7. ASSIGN REVIEWER
    if (action === 'assign_reviewer') {
      if (
        typeof b.submission_id !== 'string' ||
        typeof b.reviewer_id !== 'string'
      ) {
        return json(400, {
          error: 'invalid_assignment'
        });
      }

      const q = await rest(
        `/rest/v1/journal_submissions?id=eq.${encodeURIComponent(b.submission_id)}&select=id,journal_code`
      );

      if (!q.ok) {
        return json(502, {
          error: 'submission_lookup_failed'
        });
      }

      const rows = await q.json();

      if (!rows.length) {
        return json(404, {
          error: 'submission_not_found'
        });
      }

      const sub = rows[0];

      if (
        !(await platformAdmin(user.id)) &&
        !(await membership(
          user.id,
          sub.journal_code,
          ['editor_in_chief', 'associate_editor', 'journal_admin']
        ))
      ) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      if (
        !(await membership(
          b.reviewer_id,
          sub.journal_code,
          ['reviewer']
        ))
      ) {
        return json(400, {
          error: 'reviewer_not_appointed_to_this_journal'
        });
      }

      const ins = await rest(
        '/rest/v1/journal_reviewer_assignments',
        {
          method: 'POST',
          body: JSON.stringify({
            submission_id: sub.id,
            reviewer_id: b.reviewer_id,
            status: 'invited'
          })
        }
      );

      if (!ins.ok) {
        return json(502, {
          error: 'reviewer_assignment_failed'
        });
      }

      return json(200, { ok: true });
    }

    // 8. PUBLISH ARTICLE
    if (action === 'publish_article') {
      if (
        typeof b.submission_id !== 'string' ||
        typeof b.doi !== 'string' ||
        b.doi.length > 200 ||
        typeof b.article_url !== 'string' ||
        b.article_url.length > 1000
      ) {
        return json(400, {
          error: 'invalid_publication'
        });
      }

      const q = await rest(
        `/rest/v1/journal_submissions?id=eq.${encodeURIComponent(b.submission_id)}&select=*`
      );

      if (!q.ok) {
        return json(502, {
          error: 'submission_lookup_failed'
        });
      }

      const rows = await q.json();

      if (!rows.length) {
        return json(404, {
          error: 'submission_not_found'
        });
      }

      const sub = rows[0];

      if (sub.status !== 'accepted') {
        return json(400, {
          error: 'only_accepted_manuscripts_can_be_published'
        });
      }

      if (
        !(await platformAdmin(user.id)) &&
        !(await membership(
          user.id,
          sub.journal_code,
          ['editor_in_chief', 'journal_admin']
        ))
      ) {
        return json(403, {
          error: 'editor_in_chief_access_required'
        });
      }

      const authors = sub.authors_text
        .split(/[,;\n]/)
        .map(x => x.trim())
        .filter(Boolean);

      const ins = await rest('/rest/v1/journal_articles', {
        method: 'POST',
        headers: {
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          submission_id: sub.id,
          journal_code: sub.journal_code,
          title: sub.title,
          authors,
          abstract: sub.abstract,
          keywords: sub.keywords,
          doi: b.doi || null,
          article_url: b.article_url || null,
          status: 'published',
          published_at: new Date().toISOString()
        })
      });

      if (!ins.ok) {
        return json(502, {
          error: 'article_publication_failed'
        });
      }

      const article = (await ins.json())[0];

      const update = await rest(
        `/rest/v1/journal_submissions?id=eq.${encodeURIComponent(sub.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'published',
            updated_at: new Date().toISOString()
          })
        }
      );

      if (!update.ok) {
        return json(502, {
          error: 'submission_status_update_failed'
        });
      }

      return json(201, {
        ok: true,
        article
      });
    }

    // 9. EDITORIAL DECISION
    if (action === 'decision') {
      if (
        typeof b.submission_id !== 'string' ||
        ![
          'editorial_screening',
          'under_review',
          'revision',
          'accepted',
          'rejected'
        ].includes(b.decision) ||
        typeof b.note !== 'string' ||
        b.note.length > 3000
      ) {
        return json(400, {
          error: 'invalid_decision'
        });
      }

      const q = await rest(
        `/rest/v1/journal_submissions?id=eq.${encodeURIComponent(b.submission_id)}&select=id,journal_code`
      );

      if (!q.ok) {
        return json(502, {
          error: 'submission_lookup_failed'
        });
      }

      const rows = await q.json();

      if (!rows.length) {
        return json(404, {
          error: 'submission_not_found'
        });
      }

      const sub = rows[0];

      if (
        !(await platformAdmin(user.id)) &&
        !(await membership(
          user.id,
          sub.journal_code,
          ['editor_in_chief', 'associate_editor', 'journal_admin']
        ))
      ) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      const ins = await rest(
        '/rest/v1/journal_editorial_decisions',
        {
          method: 'POST',
          body: JSON.stringify({
            submission_id: sub.id,
            editor_id: user.id,
            decision: b.decision,
            decision_note: b.note
          })
        }
      );

      if (!ins.ok) {
        return json(502, {
          error: 'decision_log_failed'
        });
      }

      const upd = await rest(
        `/rest/v1/journal_submissions?id=eq.${encodeURIComponent(sub.id)}`,
        {
          method: 'PATCH',
          headers: {
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            status: b.decision,
            updated_at: new Date().toISOString()
          })
        }
      );

      if (!upd.ok) {
        return json(502, {
          error: 'decision_update_failed'
        });
      }

      return json(200, { ok: true });
    }

    return json(400, {
      error: 'unknown_action'
    });

  } catch (e) {
    return json(502, {
      error: 'publishing_request_failed'
    });
  }
};
