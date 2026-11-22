'use strict';

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

const anon = () =>
  process.env.SUPABASE_ANON_KEY || '';

const service = () =>
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  '';

const JOURNALS = ['bjbs', 'bjba'];

const EDITOR_ROLES = [
  'editor_in_chief',
  'associate_editor',
  'journal_admin'
];

const REVIEWER_ROLES = ['reviewer'];

const ALLOWED_RECOMMENDATIONS = [
  'accept',
  'minor_revision',
  'major_revision',
  'reject'
];

const ALLOWED_DECISIONS = [
  'editorial_screening',
  'under_review',
  'revision',
  'accepted',
  'rejected'
];

/* Supabase REST requests */
async function rest(path, options = {}) {
  const headers = {
    apikey: service(),
    Authorization: 'Bearer ' + service(),
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  return fetch(base() + path, {
    ...options,
    headers
  });
}

/* Authenticate the actual logged-in user */
async function authenticate(event) {
  const headers = event.headers || {};

  const authorization =
    headers.authorization ||
    headers.Authorization ||
    '';

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match || !base() || !anon() || !service()) {
    return null;
  }

  const response = await fetch(
    base() + '/auth/v1/user',
    {
      headers: {
        apikey: anon(),
        Authorization: 'Bearer ' + match[1]
      }
    }
  );

  if (!response.ok) {
    return null;
  }

  const user = await response.json();

  if (!user.id || !user.email_confirmed_at) {
    return null;
  }

  return user;
}

/* Check journal membership */
async function membership(userId, journalCode, roles) {
  if (!JOURNALS.includes(journalCode)) {
    return false;
  }

  const response = await rest(
    '/rest/v1/journal_memberships' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&journal_code=eq.' + encodeURIComponent(journalCode) +
    '&active=eq.true' +
    '&select=role'
  );

  if (!response.ok) {
    throw new Error('membership_lookup_failed');
  }

  const rows = await response.json();

  return rows.some(row => roles.includes(row.role));
}

/* Check platform administrator */
async function platformAdmin(userId) {
  const response = await rest(
    '/rest/v1/profiles' +
    '?id=eq.' + encodeURIComponent(userId) +
    '&select=role&limit=1'
  );

  if (!response.ok) {
    return false;
  }

  const rows = await response.json();

  return rows[0]?.role === 'admin';
}

/* Parse request body */
async function bodyOf(event) {
  try {
    let body = event.body || '{}';

    if (event.isBase64Encoded) {
      body = Buffer.from(body, 'base64').toString('utf8');
    }

    return JSON.parse(body);
  } catch {
    return null;
  }
}

/* Validate private manuscript storage path */
function validStoragePath(filePath) {
  if (typeof filePath !== 'string') {
    return false;
  }

  if (
    filePath.length > 500 ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.includes('..') ||
    filePath.includes('//')
  ) {
    return false;
  }

  const parts = filePath.split('/');

  if (parts.length !== 2) {
    return false;
  }

  const [userId, filename] = parts;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return (
    uuidPattern.test(userId) &&
    /^[a-zA-Z0-9._-]+$/.test(filename) &&
    /\.(pdf|docx)$/i.test(filename)
  );
}

/* Generate temporary manuscript download URL */
async function signedDownload(filePath) {
  if (!validStoragePath(filePath)) {
    return null;
  }

  const encodedPath = filePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const response = await fetch(
    base() +
    '/storage/v1/object/sign/journal-manuscripts/' +
    encodedPath,
    {
      method: 'POST',
      headers: {
        apikey: service(),
        Authorization: 'Bearer ' + service(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expiresIn: 600
      })
    }
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json();

  if (!data.signedURL) {
    return null;
  }

  if (data.signedURL.startsWith('https://')) {
    return data.signedURL;
  }

  return base() + '/storage/v1' + data.signedURL;
}

/* Confirm editor access */
async function editorAccess(
  userId,
  journalCode,
  roles = EDITOR_ROLES
) {
  if (!JOURNALS.includes(journalCode)) {
    return false;
  }

  if (await platformAdmin(userId)) {
    return true;
  }

  return membership(userId, journalCode, roles);
}

/* Load submission */
async function getSubmission(submissionId) {
  const response = await rest(
    '/rest/v1/journal_submissions' +
    '?id=eq.' + encodeURIComponent(submissionId) +
    '&select=*'
  );

  if (!response.ok) {
    throw new Error('submission_lookup_failed');
  }

  const rows = await response.json();

  return rows[0] || null;
}

/* Main Netlify function */
exports.handler = async event => {

  if (event.httpMethod !== 'POST') {
    return json(405, {
      error: 'method_not_allowed'
    });
  }

  if (!base() || !anon() || !service()) {
    return json(503, {
      error: 'publishing_service_not_configured'
    });
  }

  let user;

  try {
    user = await authenticate(event);
  } catch (error) {
    console.error('Authentication error:', error.message);

    return json(503, {
      error: 'authentication_unavailable'
    });
  }

  if (!user) {
    return json(401, {
      error: 'verified_login_required'
    });
  }

  const b = await bodyOf(event);

  if (!b || typeof b.action !== 'string') {
    return json(400, {
      error: 'invalid_request'
    });
  }

  const action = b.action;

  try {

    /* 1. MANUSCRIPT SUBMISSION */
    if (action === 'submit') {

      const code = b.journal_code;

      if (
        !JOURNALS.includes(code) ||
        typeof b.title !== 'string' ||
        b.title.trim().length < 8 ||
        b.title.trim().length > 300 ||
        typeof b.authors_text !== 'string' ||
        b.authors_text.trim().length < 2 ||
        b.authors_text.length > 5000 ||
        typeof b.abstract !== 'string' ||
        b.abstract.trim().length < 30 ||
        b.abstract.length > 5000 ||
        !validStoragePath(b.file_path) ||
        !b.file_path.startsWith(user.id + '/') ||
        typeof b.file_name !== 'string' ||
        b.file_name.length > 255 ||
        !/\.(pdf|docx)$/i.test(b.file_name)
      ) {
        return json(400, {
          error: 'invalid_submission_fields'
        });
      }

      const keywords = Array.isArray(b.keywords)
        ? b.keywords
            .filter(x => typeof x === 'string')
            .map(x => x.trim())
            .filter(Boolean)
            .slice(0, 20)
        : [];

      const reference =
        'BNX-' +
        code.toUpperCase() +
        '-' +
        Date.now().toString(36).toUpperCase();

      const response = await rest(
        '/rest/v1/journal_submissions',
        {
          method: 'POST',
          headers: {
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            reference_code: reference,
            journal_code: code,
            author_id: user.id,
            title: b.title.trim(),
            authors_text: b.authors_text.trim(),
            abstract: b.abstract.trim(),
            keywords,
            file_path: b.file_path,
            file_name: b.file_name,
            status: 'submitted'
          })
        }
      );

      if (!response.ok) {
        console.error(
          'Submission save failed:',
          await response.text()
        );

        return json(502, {
          error: 'submission_save_failed'
        });
      }

      const rows = await response.json();

      if (!rows.length) {
        return json(502, {
          error: 'submission_confirmation_failed'
        });
      }

      return json(201, {
        submission: {
          id: rows[0].id,
          reference_code: reference,
          status: 'submitted'
        }
      });
    }

    /* 2. AUTHOR SUBMISSION HISTORY */
    if (action === 'my_submissions') {

      const response = await rest(
        '/rest/v1/journal_submissions' +
        '?author_id=eq.' + encodeURIComponent(user.id) +
        '&select=id,reference_code,journal_code,title,status,submitted_at' +
        '&order=submitted_at.desc'
      );

      if (!response.ok) {
        return json(502, {
          error: 'submission_list_failed'
        });
      }

      return json(200, {
        submissions: await response.json()
      });
    }

    /* 3. EDITOR QUEUE */
    if (action === 'editor_queue') {

      let codes = [];

      const isAdmin = await platformAdmin(user.id);

      if (isAdmin) {

        codes = [...JOURNALS];

      } else {

        const response = await rest(
          '/rest/v1/journal_memberships' +
          '?user_id=eq.' + encodeURIComponent(user.id) +
          '&active=eq.true' +
          '&select=journal_code,role'
        );

        if (!response.ok) {
          console.error(
            'Editor membership lookup failed:',
            await response.text()
          );

          return json(502, {
            error: 'membership_lookup_failed'
          });
        }

        codes = [
          ...new Set(
            (await response.json())
              .filter(row =>
                EDITOR_ROLES.includes(row.role) &&
                JOURNALS.includes(row.journal_code)
              )
              .map(row => row.journal_code)
          )
        ];
      }

      if (!codes.length) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      const response = await rest(
        '/rest/v1/journal_submissions' +
        '?journal_code=in.(' + codes.join(',') + ')' +
        '&status=not.in.(published,withdrawn)' +
        '&select=id,reference_code,journal_code,title,abstract,status,file_path,submitted_at' +
        '&order=submitted_at.asc'
      );

      if (!response.ok) {
        console.error(
          'Editor queue failed:',
          await response.text()
        );

        return json(502, {
          error: 'editor_queue_failed'
        });
      }

      const submissions = await response.json();

      for (const submission of submissions) {
        submission.download_url =
          await signedDownload(submission.file_path);
      }

      return json(200, {
        submissions
      });
    }

    /* 4. REVIEWER QUEUE */
    if (action === 'reviewer_queue') {

      const response = await rest(
        '/rest/v1/journal_reviewer_assignments' +
        '?reviewer_id=eq.' + encodeURIComponent(user.id) +
        '&select=id,submission_id,status,created_at,' +
        'journal_submissions(id,reference_code,journal_code,title,abstract,status,file_path)' +
        '&order=created_at.desc'
      );

      if (!response.ok) {
        return json(502, {
          error: 'reviewer_queue_failed'
        });
      }

      const assignments = await response.json();

      const verifiedAssignments = [];

      for (const assignment of assignments) {

        const submission = assignment.journal_submissions;

        if (
          !submission ||
          !JOURNALS.includes(submission.journal_code)
        ) {
          continue;
        }

        if (submission.file_path) {
          assignment.download_url =
            await signedDownload(submission.file_path);
        }

        verifiedAssignments.push(assignment);
      }

      return json(200, {
        assignments: verifiedAssignments
      });
    }

    /* 5. LIST REVIEWERS */
    if (action === 'list_reviewers') {

      if (!JOURNALS.includes(b.journal_code)) {
        return json(400, {
          error: 'invalid_journal'
        });
      }

      if (
        !(await editorAccess(user.id, b.journal_code))
      ) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      const response = await rest(
        '/rest/v1/journal_memberships' +
        '?journal_code=eq.' + encodeURIComponent(b.journal_code) +
        '&role=eq.reviewer' +
        '&active=eq.true' +
        '&select=user_id'
      );

      if (!response.ok) {
        return json(502, {
          error: 'reviewer_list_failed'
        });
      }

      const ids = (await response.json())
        .map(row => row.user_id);

      if (!ids.length) {
        return json(200, {
          reviewers: []
        });
      }

      const userResponse = await fetch(
        base() + '/auth/v1/admin/users?page=1&per_page=200',
        {
          headers: {
            apikey: service(),
            Authorization: 'Bearer ' + service()
          }
        }
      );

      if (!userResponse.ok) {
        return json(502, {
          error: 'reviewer_account_lookup_failed'
        });
      }

      const users = await userResponse.json();

      return json(200, {
        reviewers: (users.users || [])
          .filter(x => ids.includes(x.id))
          .map(x => ({
            id: x.id,
            email: x.email
          }))
      });
    }

    /* 6. SUBMIT REVIEW */
    if (action === 'submit_review') {

      if (
        typeof b.assignment_id !== 'string' ||
        !ALLOWED_RECOMMENDATIONS.includes(b.recommendation) ||
        typeof b.author_comments !== 'string' ||
        b.author_comments.length > 8000 ||
        typeof b.confidential_comments !== 'string' ||
        b.confidential_comments.length > 8000
      ) {
        return json(400, {
          error: 'invalid_review'
        });
      }

      const response = await rest(
        '/rest/v1/journal_reviewer_assignments' +
        '?id=eq.' + encodeURIComponent(b.assignment_id) +
        '&reviewer_id=eq.' + encodeURIComponent(user.id) +
        '&select=id,status,submission_id'
      );

      if (!response.ok) {
        return json(502, {
          error: 'assignment_lookup_failed'
        });
      }

      const rows = await response.json();

      if (!rows.length) {
        return json(403, {
          error: 'review_assignment_required'
        });
      }

      const assignment = rows[0];

      if (assignment.status === 'completed') {
        return json(409, {
          error: 'review_already_submitted'
        });
      }

      const insert = await rest(
        '/rest/v1/journal_reviews',
        {
          method: 'POST',
          headers: {
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            assignment_id: assignment.id,
            recommendation: b.recommendation,
            author_comments: b.author_comments,
            confidential_comments: b.confidential_comments
          })
        }
      );

      if (!insert.ok) {
        console.error(
          'Review save failed:',
          await insert.text()
        );

        return json(502, {
          error: 'review_save_failed'
        });
      }

      const update = await rest(
        '/rest/v1/journal_reviewer_assignments' +
        '?id=eq.' + encodeURIComponent(assignment.id),
        {
          method: 'PATCH',
          headers: {
            Prefer: 'return=minimal'
          },
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

      return json(200, {
        ok: true
      });
    }

    /* 7. ASSIGN REVIEWER */
    if (action === 'assign_reviewer') {

      if (
        typeof b.submission_id !== 'string' ||
        typeof b.reviewer_id !== 'string'
      ) {
        return json(400, {
          error: 'invalid_assignment'
        });
      }

      const response = await rest(
        '/rest/v1/journal_submissions' +
        '?id=eq.' + encodeURIComponent(b.submission_id) +
        '&select=id,journal_code'
      );

      if (!response.ok) {
        return json(502, {
          error: 'submission_lookup_failed'
        });
      }

      const rows = await response.json();

      if (!rows.length) {
        return json(404, {
          error: 'submission_not_found'
        });
      }

      const submission = rows[0];

      if (
        !(await editorAccess(
          user.id,
          submission.journal_code
        ))
      ) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      if (
        !(await membership(
          b.reviewer_id,
          submission.journal_code,
          REVIEWER_ROLES
        ))
      ) {
        return json(400, {
          error: 'reviewer_not_appointed_to_this_journal'
        });
      }

      const insert = await rest(
        '/rest/v1/journal_reviewer_assignments',
        {
          method: 'POST',
          body: JSON.stringify({
            submission_id: submission.id,
            reviewer_id: b.reviewer_id,
            status: 'invited'
          })
        }
      );

      if (!insert.ok) {
        return json(502, {
          error: 'reviewer_assignment_failed'
        });
      }

      return json(200, {
        ok: true
      });
    }

    /* 8. EDITORIAL DECISION */
    if (action === 'decision') {

      if (
        typeof b.submission_id !== 'string' ||
        !ALLOWED_DECISIONS.includes(b.decision) ||
        typeof b.note !== 'string' ||
        b.note.length > 3000
      ) {
        return json(400, {
          error: 'invalid_decision'
        });
      }

      const submission = await getSubmission(
        b.submission_id
      );

      if (!submission) {
        return json(404, {
          error: 'submission_not_found'
        });
      }

      if (
        !(await editorAccess(
          user.id,
          submission.journal_code
        ))
      ) {
        return json(403, {
          error: 'journal_editor_access_required'
        });
      }

      const insert = await rest(
        '/rest/v1/journal_editorial_decisions',
        {
          method: 'POST',
          body: JSON.stringify({
            submission_id: submission.id,
            editor_id: user.id,
            decision: b.decision,
            decision_note: b.note
          })
        }
      );

      if (!insert.ok) {
        return json(502, {
          error: 'decision_log_failed'
        });
      }

      const update = await rest(
        '/rest/v1/journal_submissions' +
        '?id=eq.' + encodeURIComponent(submission.id),
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

      if (!update.ok) {
        return json(502, {
          error: 'decision_update_failed'
        });
      }

      return json(200, {
        ok: true
      });
    }

    /* 9. PUBLISH ARTICLE */
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

      const submission = await getSubmission(
        b.submission_id
      );

      if (!submission) {
        return json(404, {
          error: 'submission_not_found'
        });
      }

      if (submission.status !== 'accepted') {
        return json(400, {
          error: 'only_accepted_manuscripts_can_be_published'
        });
      }

      if (
        !(await editorAccess(
          user.id,
          submission.journal_code,
          ['editor_in_chief', 'journal_admin']
        ))
      ) {
        return json(403, {
          error: 'editor_in_chief_access_required'
        });
      }

      const authors = String(submission.authors_text || '')
        .split(/[,;\n]/)
        .map(x => x.trim())
        .filter(Boolean);

      const insert = await rest(
        '/rest/v1/journal_articles',
        {
          method: 'POST',
          headers: {
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            submission_id: submission.id,
            journal_code: submission.journal_code,
            title: submission.title,
            authors,
            abstract: submission.abstract,
            keywords: submission.keywords,
            doi: b.doi || null,
            article_url: b.article_url || null,
            status: 'published',
            published_at: new Date().toISOString()
          })
        }
      );

      if (!insert.ok) {
        console.error(
          'Article publication failed:',
          await insert.text()
        );

        return json(502, {
          error: 'article_publication_failed'
        });
      }

      const articles = await insert.json();

      const update = await rest(
        '/rest/v1/journal_submissions' +
        '?id=eq.' + encodeURIComponent(submission.id),
        {
          method: 'PATCH',
          headers: {
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            status: 'published',
            updated_at: new Date().toISOString()
          })
        }
      );

      if (!update.ok) {
        return json(502, {
          error: 'publication_status_update_failed'
        });
      }

      return json(201, {
        ok: true,
        article: articles[0] || null
      });
    }

    return json(400, {
      error: 'unknown_action'
    });

  } catch (error) {

    console.error(
      'Journal API error:',
      action,
      error.message
    );

    return json(502, {
      error: error.message || 'publishing_request_failed'
    });
  }
};
