/**
 * LA Metro Midlevel — Airtable relay (Cloudflare Worker)
 *
 * Purpose: sits between the Capacitor app and Airtable. Holds the Airtable
 * Personal Access Token as a server-side secret (set via `wrangler secret put`,
 * never in this file, never in the app). Receives a form submission from the
 * app, re-validates it (the client is never trusted for anything that
 * matters — Capacitor JS is fully inspectable/tamperable on-device), and
 * writes it into the "Applications" table.
 *
 * Template note for future Rick apps: everything project-specific lives in
 * the FIELD_MAP below and the three env vars (AIRTABLE_TOKEN,
 * AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME). Copy this file, change those, done.
 *
 * Multiple forms, same base: routed by URL path. POST / keeps writing to the
 * "Applications" table (gospel-workers-application.html), unchanged. POST
 * /member-survey writes to the "Member Survey" table (member survey repo).
 * Both share AIRTABLE_TOKEN and AIRTABLE_BASE_ID; each route has its own
 * FIELD_MAP, REQUIRED_FIELDS, and table-name env var.
 */

// Maps the app's field names -> exact Airtable column names.
// Confirmed against Rick's "LA Metro Midlevel 2026" base, "Applications" table.
// The old "Barriers" and "Prayer Time" columns are no longer written to --
// "Barriers" was superseded by "Challenges" when the Church Health survey
// was merged into this form; "Prayer Time" was dropped from the form itself.
// doingWellElements/couldGrowElements/hasElders/etc. arrive as arrays/
// booleans/numbers -- see the `clean` step below for how each type is
// handled before being sent to Airtable.
const FIELD_MAP = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  church: 'Church',
  laArea: 'LA Area',
  wins: 'Wins',
  challenges: 'Challenges',
  doingWellElements: 'Doing Well (Checked)',
  doingWell: 'Doing Well',
  couldGrowElements: 'Could Grow (Checked)',
  couldGrow: 'Could Grow',
  churchHealthAlreadyDone: 'Church Health Already Done',
  hasElders: 'Has Elders',
  elders: 'Elders',
  baptisms: 'Baptisms',
  consistentMembers: 'Consistent Members',
  comeAndGo: 'Come And Go',
  meetingLocation: 'Meeting Location',
  multipleHouses: 'Multiple Houses',
  houseZipCodes: 'House Zip Codes',
  sharedMeal: 'Shared Meal',
  meetingDay: 'Meeting Day',
  meetingTime: 'Meeting Time',
  scriptureWord: 'Word',
  scriptureWorks: 'Works',
  scriptureWineskins: 'Wineskins',
};

// Fields the client must supply a non-empty value for. Everything else is
// optional in the form (no `required` attribute), so it's excluded here.
const REQUIRED_FIELDS = ['name', 'email', 'phone', 'church', 'laArea'];

// "Member Survey" table -- member-survey repo's index.html.
// doingWellElements/couldGrowElements arrive as arrays (checklist values) --
// see the array handling in the `clean` step below, which joins them into a
// comma-separated string for these two text columns.
const MEMBER_SURVEY_FIELD_MAP = {
  anonymous: 'Anonymous',
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  church: 'Church',
  location: 'Location',
  wins: 'Wins',
  challenges: 'Challenges',
  doingWellElements: 'Doing Well (Checked)',
  doingWell: 'Doing Well',
  couldGrowElements: 'Could Grow (Checked)',
  couldGrow: 'Could Grow',
  scriptureWord: 'Word',
  scriptureWorks: 'Works',
  scriptureWineskins: 'Wineskins',
};

// phone/wins/challenges/doingWell/couldGrow/scripture* are optional in the
// form (no `required` attribute), so they're excluded here. name/email are
// dropped from the requirement below when the respondent checks "anonymous".
const MEMBER_SURVEY_REQUIRED_FIELDS = ['name', 'email', 'church'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed.' }, 405);
    }

    const url = new URL(request.url);
    const isMemberSurvey = url.pathname.replace(/\/+$/, '') === '/member-survey';
    const fieldMap = isMemberSurvey ? MEMBER_SURVEY_FIELD_MAP : FIELD_MAP;
    let requiredFields = isMemberSurvey ? MEMBER_SURVEY_REQUIRED_FIELDS : REQUIRED_FIELDS;
    const tableNameVar = isMemberSurvey ? env.AIRTABLE_MEMBER_SURVEY_TABLE_NAME : env.AIRTABLE_TABLE_NAME;

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid request.' }, 400);
    }

    // ---- Server-side validation. This is the authority, not the client's. ----
    // `null` is a client-sent sentinel for "not applicable" (e.g. church
    // health numbers when someone else already submitted that section) --
    // it's kept as null so the field-building step below can omit it,
    // rather than coercing it into a misleading 0 or empty string.
    const clean = (v) => {
      if (Array.isArray(v)) return v.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean).join(', ');
      if (typeof v === 'boolean' || typeof v === 'number') return v;
      if (v === null) return null;
      return typeof v === 'string' ? v.trim() : '';
    };
    const entry = {};
    for (const key of Object.keys(fieldMap)) {
      entry[key] = clean(body[key]);
    }

    // Anonymous member-survey respondents skip name/email entirely.
    if (isMemberSurvey && entry.anonymous === true) {
      requiredFields = requiredFields.filter((k) => k !== 'name' && k !== 'email');
    }

    const missing = requiredFields.filter((k) => !entry[k]);
    if (missing.length) {
      return json(
        { ok: false, error: `Missing required field(s): ${missing.join(', ')}.` },
        400
      );
    }
    if (entry.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) {
      return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
    }

    // Omit null (not-applicable) and empty-string values entirely rather
    // than sending them -- booleans (including false) and numbers
    // (including 0) are meaningful and always sent.
    const fields = {};
    for (const [key, airtableCol] of Object.entries(fieldMap)) {
      const v = entry[key];
      if (v === null || v === '') continue;
      fields[airtableCol] = v;
    }

    if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID || !tableNameVar) {
      console.error('Relay misconfigured: missing one of AIRTABLE_TOKEN / AIRTABLE_BASE_ID / table name for this route');
      return json({ ok: false, error: 'Server is not configured yet. Please try again later.' }, 500);
    }

    const airtableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableNameVar)}`;

    const writeToAirtable = () =>
      fetch(airtableUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        // typecast:true lets Airtable coerce plain strings into the target
        // column type (e.g. a Single Select option it hasn't seen yet).
        // Verify this against the real base with a first live test submission --
        // if a field is a strict Single Select with no "add new options"
        // permission, typecast will NOT create the option and Airtable will
        // reject the write instead.
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });

    let res;
    try {
      res = await writeToAirtable();
    } catch (err) {
      console.error('Airtable request threw:', err);
      return json({ ok: false, error: 'Could not reach the database. Please try again.' }, 502);
    }

    // One bounded retry on rate-limit (429) or transient server error (5xx).
    // Airtable's limit is 5 req/sec per base -- this app gets nowhere near
    // that, so this is just a safety net, not a real backoff system.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        res = await writeToAirtable();
      } catch (err) {
        console.error('Airtable retry threw:', err);
        return json({ ok: false, error: 'Could not reach the database. Please try again.' }, 502);
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Airtable rejected write:', res.status, errText);
      return json(
        { ok: false, error: 'Could not save your response right now. Please try again in a moment.' },
        502
      );
    }

    const data = await res.json().catch(() => null);
    const recordId = data && data.records && data.records[0] && data.records[0].id;
    console.log('Saved application', recordId || '(no id returned)');

    return json({ ok: true }, 200);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
