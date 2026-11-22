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

const JOURNALS = ['bjbs', 'bjba'];

const EDITOR_ROLES = [
  'editor',
  'journal_editor',
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

/*
 * Supabase REST requests using the configured secret API key.
 * Do not expose this key to the browser.
 */
async function rest(path, options = {}) {
  const headers = {
    apikey: service(),
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  return fetch(base() + path, {
    ...options,
    headers
  });
}

/*
 * Verify the user's real Supabase access token.
 */
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

  const response = await fetch(base() + '/auth/v1/user', {
    headers: {
      apikey: anon(),
      Authorization: 'Bearer ' + match[1]
    }
  });

  if (!response.ok) {
    return null;
  }

  const user = await response.json();

  if (!user.id || !user.email_confirmed_at) {
    return null;
  }

  return user;
}

/*
 * Check active journal membership and role.
 */
async function membership(userId, journalCode, roles) {
  if (!JOURNALS.includes(journalCode)) {
    return false;
  }

  const query =
    '/rest/v1/journal_memberships' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&journal_code=eq.' + encodeURIComponent(journalCode) +
    '&active=eq.true' +
    '&select=role';

  const response = await rest(query);

  if (!response.ok) {
    throw new Error('membership_lookup_failed');
  }

  const rows = await response.json();

  return rows.some(row => roles.includes(row.role));
}

/*
 * Check platform administrator.
 */
async function platformAdmin(userId) {
  const response = await rest(
    '/rest/v1/profiles' +
    '?id=eq.' + encodeURIComponent(userId) +
    '&select=role&limit=1'
  );

  if (!response.ok) {
    throw new Error('admin_lookup_failed');
  }

  const rows = await response.json();

  return rows[0]?.role === 'admin';
}

/*
 * Parse request body.
 */
async function bodyOf(event) {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return null;
  }
}

/*
 * Validate storage paths before generating signed URLs.
 */
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

/*
 * Generate a temporary private manuscript download URL.
 */
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

/*
 * Confirm that an editor has access to a journal.
 */
async function editorAccess(userId, journalCode, roles = EDITOR_ROLES) {
  if (!JOURNALS.includes(journalCode)) {
    return false;
  }

  if (await platformAdmin(userId)) {
    return true;
  }

  return membership(userId, journalCode, roles);
}

/*
 * Load a submission by ID.
 */
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

/*
 * Main Netlify function.
 */
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
  } catch {
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

    /*
     * 1. MANUSCRIPT SUBMISSION
     */
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

    /*
     * 2. AUTHOR SUBMISSION HISTORY
     */
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

    /*
     * 3. EDITOR QUEUE
     */
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

    /*
     * 4. REVIEWER QUEUE
     */
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

        if (!submission) {
          continue;
        }

        if (!JOURNALS.includes(submission.journal_code
