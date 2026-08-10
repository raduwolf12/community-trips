// Built plugin entry — runs in an isolated child process.
const { definePlugin } = require('trek-plugin-sdk');

const GITHUB_API_BASE = 'https://api.github.com';
// Same marketplace repo Featured Guides already publishes to — deliberately unchanged by this
// plugin split, so every trip PR/Discussion opened before the split (and every already-merged
// marketplace/trips/*.json entry) keeps working with zero migration on the GitHub side.
const GITHUB_OWNER = 'raduwolf12';
const GITHUB_REPO = 'featured-guides';
const GITHUB_FETCH_TIMEOUT_MS = 8000;

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function error(status, message) {
  return json(status, { error: message });
}

function requireAdmin(req) {
  if (!req.user || !req.user.isAdmin) return error(403, 'Admin only');
  return null;
}

function parseTips(raw) {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string' && t.trim()).slice(0, 20);
  return [];
}

// ctx.trips/collections methods don't return a guaranteed bare array on every host — probe
// the common wrapper shapes ({items:[]}, {trips:[]}, {data:[]}, {results:[]}) before giving up.
// A host that hands back something genuinely unrecognized degrades to an empty list instead of
// throwing.
function toArray(maybeArray) {
  if (Array.isArray(maybeArray)) return maybeArray;
  if (!maybeArray || typeof maybeArray !== 'object') return [];
  for (const key of ['items', 'trips', 'places', 'data', 'results']) {
    if (Array.isArray(maybeArray[key])) return maybeArray[key];
  }
  return [];
}

// GitHub's REST API has no create/list/comment endpoints for repository Discussions (only
// organization-level "team discussions", a different feature) — that surface is GraphQL-only.
// Everything Discussion-shaped (category lookup, create, list, comment) goes through this
// instead of githubFetch below.
async function githubGraphQL(token, query, variables) {
  if (!token) throw new Error("Set your GitHub personal access token in this plugin's settings first.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}/graphql`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json();
    if (!res.ok || data.errors) {
      throw new Error((data.errors && data.errors.map((e) => e.message).join('; ')) || `GitHub GraphQL request failed (${res.status})`);
    }
    return data.data;
  } finally {
    clearTimeout(timer);
  }
}

// Same shape as above — takes an already-resolved token rather than fetching it itself. Used for
// both the write side (opening a Share Trip PR/Discussion) and the read side (listing/posting
// suggestions), always with the CLICKING user's own PAT so GitHub attributes every commit/comment
// to them, never to this plugin.
async function githubFetch(token, path, opts) {
  if (!token) throw new Error("Set your GitHub personal access token in this plugin's settings first.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...opts,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts && opts.headers),
      },
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data && data.message) || `GitHub request failed (${res.status})`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Place/block shaping — shared by /guide/import-trip in Featured Guides and /trip/share
// here, kept in sync deliberately since they both convert the same ctx.trips shape into the same
// block JSON. Duplicated rather than shared at runtime: these are two independent plugins now,
// each its own deployable with no shared package between them. ----

const HEADING_LEVELS = ['normal', 'medium', 'large'];
// Fixed place-category taxonomy — keep in sync with PLACE_CATEGORIES/CATEGORIES in
// featured-guides' server/client, and with CATEGORIES/CATEGORY_COLORS in this plugin's own client.
const PLACE_CATEGORIES = ['Activity', 'Attraction', 'Bar/Cafe', 'Beach', 'Hotel', 'Nature', 'Other', 'Restaurant', 'Shopping', 'Transport'];
const CATEGORY_KEYWORDS = [
  ['Hotel', ['hotel', 'hostel', 'guesthouse', 'guest house', 'apartment', 'accommodation', 'accomodation', 'lodging', 'resort', 'inn']],
  ['Restaurant', [
    'restaurant', 'food', 'dining', 'eatery', 'bakery', 'bistro', 'diner', 'dessert', 'brunch',
    'steakhouse', 'pizza', 'sushi', 'noodles', 'bbq', 'seafood',
    'korean', 'japanese', 'chinese', 'thai', 'italian', 'french', 'indian', 'vietnamese', 'mexican',
  ]],
  ['Bar/Cafe', ['bar', 'cafe', 'café', 'pub', 'winery', 'brewery', 'coffee']],
  ['Beach', ['beach', 'coast', 'shore']],
  ['Nature', ['nature', 'natural', 'park', 'trail', 'forest', 'mountain', 'waterfall', 'lake', 'hiking', 'campsite', 'national park', 'wildlife', 'garden']],
  ['Shopping', ['shop', 'shopping', 'mall', 'market', 'supermarket', 'store', 'duty free']],
  ['Transport', ['airport', 'transport', 'station', 'parking', 'bus', 'train', 'ferry', 'gas station', 'car park']],
  ['Activity', ['activity', 'spa', 'amusement', 'sport', 'tour', 'swimming', 'pool', 'entertainment']],
  ['Attraction', ['attraction', 'museum', 'church', 'landmark', 'monument', 'lighthouse', 'viewpoint', 'historic', 'architecture', 'castle', 'palace', 'tourist', 'interesting_places']],
];
function normalizeCategory(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const exact = PLACE_CATEGORIES.find((c) => c.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const low = s.toLowerCase();
  for (const [canonical, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => low.includes(k))) return canonical;
  }
  return 'Other';
}

const MAX_UPLOAD_BYTES = 60_000;
const MAX_PHOTO_BYTES = 1_500_000;
function dataUriByteSize(dataUri) {
  const comma = dataUri.indexOf(',');
  const b64 = comma === -1 ? dataUri : dataUri.slice(comma + 1);
  return b64.length;
}

function validateBlockData(type, raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  switch (type) {
    case 'day': {
      const dayNumber = Number(d.dayNumber);
      if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 366) return 'dayNumber must be a whole number between 1 and 366';
      return { dayNumber, title: d.title ? String(d.title).slice(0, 200) : null };
    }
    case 'heading': {
      if (!d.text || !String(d.text).trim()) return 'text is required';
      const level = HEADING_LEVELS.includes(d.level) ? d.level : 'normal';
      return { text: String(d.text).trim().slice(0, 200), level };
    }
    case 'body':
      if (!d.text || !String(d.text).trim()) return 'text is required';
      return { text: String(d.text).trim().slice(0, 5000) };
    case 'place':
      if (!d.name || !String(d.name).trim()) return 'name is required';
      return {
        name: String(d.name).trim().slice(0, 200),
        category: normalizeCategory(d.category),
        description: d.description ? String(d.description).slice(0, 2000) : null,
        address: d.address ? String(d.address).slice(0, 500) : null,
        lat: typeof d.lat === 'number' ? d.lat : null,
        lon: typeof d.lon === 'number' ? d.lon : null,
        rating: Number.isInteger(d.rating) ? d.rating : null,
        tips: parseTips(d.tips),
        photoDataUri: (typeof d.photoDataUri === 'string' && d.photoDataUri.startsWith('data:image/') && dataUriByteSize(d.photoDataUri) <= MAX_PHOTO_BYTES)
          ? d.photoDataUri : null,
        source: d.source || 'manual',
        xid: d.xid || null,
      };
    default:
      return `unknown block type "${type}"`;
  }
}

// Sanitizes one place item the same way validateBlockData('place', ...) would.
function sanitizePdfPlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.name && String(raw.name).trim().slice(0, 200);
  if (!name) return null;
  const dayNumber = Number(raw.dayNumber);
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  return {
    name,
    category: raw.category ? String(raw.category).trim().slice(0, 100) : null,
    address: raw.address ? String(raw.address).trim().slice(0, 500) : null,
    description: raw.description ? String(raw.description).trim().slice(0, 2000) : null,
    tips: parseTips(raw.tips),
    dayNumber: Number.isInteger(dayNumber) && dayNumber > 0 && dayNumber <= 366 ? dayNumber : null,
    dayTitle: raw.dayTitle ? String(raw.dayTitle).trim().slice(0, 200) : null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  };
}

// TREK's own Place objects mirror the raw DB row, with the real field names undocumented beyond
// "only `id` is guaranteed" — probe the plausible synonym set for each field.
function tripPlaceRow(p) {
  return {
    id: p.id,
    name: p.name || p.title || null,
    description: p.description || p.notes || null,
    address: p.address || null,
    category: p.category || null,
    lat: typeof p.lat === 'number' ? p.lat : (typeof p.latitude === 'number' ? p.latitude : null),
    lon: typeof p.lon === 'number' ? p.lon : (typeof p.lng === 'number' ? p.lng : (typeof p.longitude === 'number' ? p.longitude : null)),
  };
}

// TREK's own Day objects mirror the raw DB row too, with no field documented for which places are
// scheduled on that day — probe the plausible key names. Returns [] (rather than guessing wrong)
// if none match, so that day's places just fall back to the trip's unscheduled pool.
function dayAssignedPlaceIds(day) {
  for (const key of ['places', 'itinerary', 'assignments', 'items', 'entries']) {
    const val = day[key];
    if (Array.isArray(val)) {
      return val.map((v) => (v && typeof v === 'object' ? (v.place_id ?? v.placeId ?? v.id) : v)).filter((id) => id != null);
    }
  }
  return [];
}

function tripReservationText(r) {
  if (!r || typeof r !== 'object') return null;
  const kind = r.type || r.kind || r.category || 'Reservation';
  const title = r.title || r.name || r.label || null;
  const carrier = r.carrier || r.airline || r.operator || r.provider || null;
  const number = r.number || r.flight_number || r.reference || r.confirmation_number || r.booking_ref || null;
  const legs = Array.isArray(r.endpoints) ? r.endpoints : (Array.isArray(r.legs) ? r.legs : []);
  const first = legs[0] || {};
  const last = legs[legs.length - 1] || first;
  const from = first.from || first.from_location || first.origin || first.departure_location || null;
  const to = last.to || last.to_location || last.destination || last.arrival_location || null;
  const when = first.depart_at || first.departure_time || first.date || first.time || r.date || r.start_date || null;

  const labelParts = [String(kind)];
  if (carrier) labelParts.push(String(carrier));
  if (number) labelParts.push('#' + number);
  let line = title ? String(title) : labelParts.join(' ');
  const details = [];
  if (from && to) details.push(`${from} → ${to}`);
  if (when) details.push(String(when).replace('T', ' ').slice(0, 16));
  if (details.length) line += ': ' + details.join(', ');
  return { text: line.slice(0, 300), sortDate: when ? String(when) : '' };
}
function tripAccommodationText(a) {
  if (!a || typeof a !== 'object') return null;
  const name = a.name || a.title || a.label || 'Accommodation';
  const checkin = a.checkin || a.check_in || a.checkInDate || a.start_date || a.from || null;
  const checkout = a.checkout || a.check_out || a.checkOutDate || a.end_date || a.to || null;
  const address = a.address || null;
  const details = [];
  if (checkin && checkout) details.push(`${String(checkin).slice(0, 10)} → ${String(checkout).slice(0, 10)}`);
  if (address) details.push(String(address));
  let line = 'Hotel — ' + String(name);
  if (details.length) line += ': ' + details.join(', ');
  return { text: line.slice(0, 300), sortDate: checkin ? String(checkin) : '' };
}

// In-memory {type, data} block builder from a flat place list — used by /trip/share, which needs
// the block JSON to put in a GitHub file, not in any db:own storage.
function placesToBlockList(places) {
  let lastDay;
  let dayBlocksInserted = 0;
  const blocks = [];
  for (const p of places) {
    if (p.dayNumber != null && p.dayNumber !== lastDay) {
      blocks.push({ type: 'day', data: { dayNumber: p.dayNumber, title: p.dayTitle || null } });
      lastDay = p.dayNumber;
      dayBlocksInserted++;
    }
    const normalized = validateBlockData('place', { ...p, source: 'pdf-import' });
    if (typeof normalized === 'string') continue;
    blocks.push({ type: 'place', data: normalized });
  }
  return { blocks, dayBlocksInserted, placesInserted: blocks.filter((b) => b.type === 'place').length };
}

// Converts a live TREK trip into {title, location, places, bookingBlocks} for /trip/share to
// serialize into a GitHub file. Returns { error } (an error() response) on failure, never throws.
async function tripToGuidePayload(ctx, tripId) {
  let trip;
  try {
    trip = await ctx.trips.getById(tripId);
  } catch (e) {
    return { error: error(403, "You don't have access to that trip.") };
  }
  if (!trip) return { error: error(404, 'Trip not found') };

  let rawPlaces;
  try {
    rawPlaces = toArray(await ctx.trips.getPlaces(tripId));
  } catch (e) {
    return { error: error(502, "Could not read that trip's places: " + String(e && e.message || e)) };
  }
  let rawDays;
  try {
    rawDays = toArray(await ctx.trips.getDays(tripId));
  } catch {
    rawDays = [];
  }
  let rawReservations = [];
  try { rawReservations = toArray(await ctx.trips.getReservations(tripId)); } catch {}
  let rawAccommodations = [];
  try { rawAccommodations = toArray(await ctx.trips.getAccommodations(tripId)); } catch {}

  const places = rawPlaces.map(tripPlaceRow).filter((p) => p.name);
  rawDays.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  const dayNumberByPlaceId = {};
  const dayTitleByNumber = {};
  rawDays.forEach((d, i) => {
    const dayNumber = i + 1;
    const title = d.title || d.note || d.name;
    if (title) dayTitleByNumber[dayNumber] = String(title).trim().slice(0, 200);
    for (const placeId of dayAssignedPlaceIds(d)) dayNumberByPlaceId[placeId] = dayNumber;
  });

  const asPlaces = places.map((p) => {
    const dayNumber = p.id != null && dayNumberByPlaceId[p.id] != null ? dayNumberByPlaceId[p.id] : null;
    return {
      name: p.name, category: p.category, address: p.address, description: p.description,
      lat: p.lat, lon: p.lon, dayNumber,
      dayTitle: dayNumber != null ? (dayTitleByNumber[dayNumber] || null) : null,
    };
  });
  asPlaces.sort((a, b) => {
    if (a.dayNumber == null && b.dayNumber == null) return 0;
    if (a.dayNumber == null) return 1;
    if (b.dayNumber == null) return -1;
    return a.dayNumber - b.dayNumber;
  });

  const sanitized = asPlaces.map(sanitizePdfPlace).filter(Boolean);
  const hasDays = sanitized.some((p) => p.dayNumber != null);
  const title = (trip.title && String(trip.title).trim().slice(0, 200)) || 'Imported trip';
  const location = trip.location ? String(trip.location).trim().slice(0, 200) : null;

  const bookingItems = [
    ...rawReservations.map(tripReservationText),
    ...rawAccommodations.map(tripAccommodationText),
  ].filter(Boolean);
  bookingItems.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  const bookingBlocks = [];
  if (bookingItems.length) {
    const headingData = validateBlockData('heading', { text: 'Travel & Stays', level: 'medium' });
    bookingBlocks.push({ type: 'heading', data: headingData });
    for (const item of bookingItems) {
      const bodyData = validateBlockData('body', { text: item.text });
      if (typeof bodyData !== 'string') bookingBlocks.push({ type: 'body', data: bodyData });
    }
  }

  return { title, location, hasDays, sanitized, bookingItems, bookingBlocks, totalPlaces: places.length };
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'trip';
}

// Seed body for the Discussion opened alongside a Share Trip PR.
function buildTripDiscussionBody(trip, prUrl) {
  const lines = [
    `**${trip.title}**${trip.location ? ` — ${trip.location}` : ''}`,
    '',
    trip.dayCount ? `${trip.dayCount} day${trip.dayCount === 1 ? '' : 's'}, ${trip.placeCount} place${trip.placeCount === 1 ? '' : 's'}.` : `${trip.placeCount} place${trip.placeCount === 1 ? '' : 's'}, no day breakdown.`,
    '',
    `Shared via the Community Trips plugin. The full itinerary is in the linked pull request — once merged it'll show up here for anyone to import.`,
    '',
    `➡️ ${prUrl}`,
    '',
    '---',
    '',
    'Been here, or planning to go? Drop a suggestion below — a place to add, a day to reorder, a warning about something that\'s changed. The trip\'s author can fold any of it back in before or after the PR merges.',
  ];
  return lines.join('\n');
}

// Finds an existing Discussion by exact title, so re-sharing a trip whose local `trip_shares` row
// was lost (the exact situation every previously-shared trip is in right after this plugin split,
// since trip_shares lived in Featured Guides' own isolated db:own storage and has no cross-plugin
// migration path) reuses the real thread instead of creating a duplicate, orphaned one — the same
// "reuse on already-exists" pattern the branch/PR steps below already use.
async function findExistingDiscussionByTitle(token, title) {
  const data = await githubGraphQL(
    token,
    `query($owner:String!,$name:String!){
      repository(owner:$owner,name:$name){
        discussions(first:50, orderBy:{field:CREATED_AT, direction:DESC}){ nodes{ id number url title } }
      }
    }`,
    { owner: GITHUB_OWNER, name: GITHUB_REPO }
  );
  const nodes = (data.repository.discussions && data.repository.discussions.nodes) || [];
  return nodes.find((n) => n.title === title) || null;
}

module.exports = definePlugin({
  async onLoad(ctx) {
    // One row per TREK trip that's been shared here — tripId is a host-managed ctx.trips id.
    // Lets the client show "PR open"/"view suggestions" instead of re-sharing, and gives
    // /trip/suggestions the discussion to read from without another GitHub round trip.
    await ctx.db.migrate('001_trip_shares', `
      CREATE TABLE IF NOT EXISTS trip_shares (
        trip_id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL,
        pr_url TEXT,
        discussion_number INTEGER,
        discussion_url TEXT,
        discussion_node_id TEXT,
        shared_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // One row per trip imported from the Community Trips list into a local, editable-nowhere
    // (read-only) draft copy — same "land as a Draft" behavior the old Featured-Guides-hosted
    // flow had, just stored here instead of in a `guides` table this plugin doesn't have.
    await ctx.db.migrate('002_imported_trips', `
      CREATE TABLE IF NOT EXISTS imported_trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        location TEXT,
        blocks TEXT NOT NULL DEFAULT '[]',
        source_updated_at TEXT,
        imported_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    ctx.log.info('community-trips loaded');
  },

  // Manifest `actions[]` button on the plugin's own settings page — tests the CLICKING user's own
  // saved PAT against a cheap, read-only GitHub call, so an admin finds out their token is bad the
  // moment they paste it in rather than on their first real Share/Suggestion.
  actions: {
    async test_connection(ctx) {
      const token = await ctx.settings.get('github_pat');
      if (!token) return { ok: false, message: 'No token saved yet — paste one above, then test it.' };
      try {
        const repo = await githubFetch(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`);
        if (repo && repo.full_name) return { ok: true, message: 'Looks good — GitHub accepted this token.' };
        return { ok: false, message: 'GitHub responded, but not with what was expected — double-check the token.' };
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e).slice(0, 200) };
      }
    },
  },

  routes: [
    {
      // Lets this plugin's page show the right hints (e.g. "set a token to post suggestions")
      // to any signed-in user, not just admins — browsing/viewing a Discussion needs no admin
      // rights at all, only Share/posting a suggestion do (still gated by requireAdmin on those
      // routes). Deliberately just a boolean: never echoes the token itself back to the client.
      method: 'GET', path: '/me/github-pat-status', auth: true,
      async handler(req, ctx) {
        const token = await ctx.settings.get('github_pat');
        return json(200, { hasToken: !!token });
      },
    },
    {
      // Lists the signed-in user's own trips, for the Share Trip picker.
      method: 'GET', path: '/trips', auth: true,
      async handler(req, ctx) {
        try {
          const trips = toArray(await ctx.trips.listMine());
          return json(200, {
            trips: trips.map((t) => ({ id: t.id, title: t.title, startDate: t.start_date, endDate: t.end_date })),
          });
        } catch (e) {
          return error(502, 'Could not load your trips: ' + (e && e.message || e));
        }
      },
    },
    {
      // Opens a PR against the shared marketplace repo adding the trip as
      // marketplace/trips/<slug>.json + an index.json entry, plus a Discussion seeded with a
      // summary + link back to the PR for "Suggestions" comments to land in. Everything is done
      // with the CLICKING admin's own PAT (githubFetch) so GitHub attributes the commit/PR/
      // discussion to them, not to this plugin. Idempotent: re-sharing an already-shared trip
      // just returns the existing links from trip_shares instead of opening a second PR/Discussion.
      method: 'POST', path: '/trip/share', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const tripId = Number(b.tripId);
        if (!Number.isInteger(tripId)) return error(400, 'tripId is required');

        const existing = await ctx.db.query('SELECT * FROM trip_shares WHERE trip_id = ?', tripId);
        if (existing.length) {
          const row = existing[0];
          return json(200, { alreadyShared: true, prUrl: row.pr_url, discussionUrl: row.discussion_url });
        }

        const token = await ctx.settings.get('github_pat');
        if (!token) return error(400, "Set your GitHub personal access token in this plugin's settings first.");

        const payload = await tripToGuidePayload(ctx, tripId);
        if (payload.error) return payload.error;
        const { title, location, sanitized, bookingBlocks, totalPlaces } = payload;
        if (!totalPlaces) return error(400, 'Add at least one place to this trip before sharing it — an empty itinerary has nothing for others to browse.');

        const { blocks: placeBlocks, dayBlocksInserted, placesInserted } = placesToBlockList(sanitized);
        const guidePayload = {
          guide: { title, location, description: null, template: dayBlocksInserted ? 'itinerary' : 'list' },
          blocks: [...bookingBlocks, ...placeBlocks],
        };
        const slug = `${slugify(title)}-${tripId}`;
        const today = new Date().toISOString().slice(0, 10);
        const indexEntry = {
          id: slug, title, location: location || null, description: null, author: req.user.name || req.user.email || 'a TREK admin',
          coverPhoto: null, placeCount: placesInserted, days: dayBlocksInserted || null,
          addedAt: today, updatedAt: today, file: `trips/${slug}.json`,
        };

        let branch, prUrl, discussionNumber, discussionUrl, discussionNodeId;
        try {
          const mainRef = await githubFetch(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/main`);
          const baseSha = mainRef.object.sha;
          branch = `share-trip-${slug}`;
          // A previous attempt at this same share can have gotten partway (branch/PR created,
          // then a later step throwing) without ever reaching the trip_shares INSERT at the
          // bottom, so a retry lands here with the branch already existing on GitHub even though
          // this plugin's own DB has no record of it. Treat "already exists" as success.
          try {
            await githubFetch(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`, {
              method: 'POST',
              body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
            });
          } catch (e) {
            if (!/already exists/i.test(String(e && e.message))) throw e;
          }

          // Reads the branch's own current copy (not main's) so a retry that already committed
          // on a previous attempt gets that file's real sha instead of guessing whether it needs
          // one at all — GitHub's Contents API 422s a create-style PUT against a path that
          // already exists on that ref, and 409s an update-style PUT missing sha for one that does.
          async function putOnBranch(path, message, computeContent) {
            let sha, currentText;
            try {
              const existingFile = await githubFetch(
                token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${branch}`
              );
              sha = existingFile.sha;
              currentText = Buffer.from(existingFile.content, 'base64').toString('utf8');
            } catch { /* doesn't exist on this branch yet */ }
            const content = computeContent(currentText);
            await githubFetch(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
              method: 'PUT',
              body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), branch, ...(sha ? { sha } : {}) }),
            });
          }

          await putOnBranch(
            `marketplace/trips/${slug}.json`,
            `Add community trip: ${title}`,
            () => JSON.stringify(guidePayload, null, 2)
          );

          // A PR from this branch can already be open from a prior attempt that failed after
          // this point — reuse it instead of erroring on GitHub's "already exists" 422.
          try {
            const pr = await githubFetch(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`, {
              method: 'POST',
              body: JSON.stringify({
                title: `Community trip: ${title}`,
                head: branch, base: 'main',
                body: `Shared from a TREK trip via the Community Trips plugin.\n\n- **${totalPlaces}** places\n- **${dayBlocksInserted || 0}** days\n\nAdds \`marketplace/trips/${slug}.json\` and lists it in \`marketplace/trips/index.json\`.`,
              }),
            });
            prUrl = pr.html_url;
          } catch (e) {
            if (!/already exists/i.test(String(e && e.message))) throw e;
            const existingPrs = await githubFetch(
              token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?head=${GITHUB_OWNER}:${branch}&state=all`
            );
            prUrl = existingPrs[0] && existingPrs[0].html_url;
          }

          // Repository Discussions have no REST create/list/comment endpoints (only the
          // unrelated org-level "team discussions" do) — githubGraphQL is required here.
          const discussionTitle = `Suggestions: ${title}`;
          const reused = await findExistingDiscussionByTitle(token, discussionTitle).catch(() => null);
          if (reused) {
            discussionNumber = reused.number;
            discussionUrl = reused.url;
            discussionNodeId = reused.id;
          } else {
            const catData = await githubGraphQL(
              token,
              `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id discussionCategories(first:10){ nodes{ id name } } } }`,
              { owner: GITHUB_OWNER, name: GITHUB_REPO }
            );
            const repoId = catData.repository.id;
            const categories = catData.repository.discussionCategories.nodes;
            const category = categories.find((c) => /general|q&a|ideas/i.test(c.name)) || categories[0];
            if (!category) throw new Error('This repo has no Discussion categories set up yet.');

            const discussionData = await githubGraphQL(
              token,
              `mutation($repoId:ID!,$categoryId:ID!,$title:String!,$body:String!){
                createDiscussion(input:{repositoryId:$repoId,categoryId:$categoryId,title:$title,body:$body}) {
                  discussion { id number url }
                }
              }`,
              {
                repoId, categoryId: category.id,
                title: discussionTitle,
                body: buildTripDiscussionBody({ title, location, placeCount: totalPlaces, dayCount: dayBlocksInserted || 0 }, prUrl),
              }
            );
            const discussion = discussionData.createDiscussion.discussion;
            discussionNumber = discussion.number;
            discussionUrl = discussion.url;
            discussionNodeId = discussion.id;
          }

          // Committed after the discussion exists (and after the PR is open — a later commit on
          // the same branch just shows up in the PR's diff automatically, no extra step needed)
          // so the Community Trips list entry can carry a working discussionUrl from the start,
          // instead of every browsing user needing to open the PR first to find it.
          await putOnBranch(
            `marketplace/trips/index.json`,
            `List community trip: ${title}`,
            (currentText) => {
              const current = currentText ? JSON.parse(currentText) : [];
              const withoutThisSlug = current.filter((e) => e.id !== slug);
              return JSON.stringify([...withoutThisSlug, { ...indexEntry, discussionUrl }], null, 2);
            }
          );
        } catch (e) {
          return error(502, 'GitHub request failed: ' + String(e && e.message || e));
        }

        await ctx.db.exec(
          'INSERT INTO trip_shares (trip_id, slug, pr_url, discussion_number, discussion_url, discussion_node_id, shared_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          tripId, slug, prUrl, discussionNumber, discussionUrl, discussionNodeId, req.user.name || req.user.email || null
        );

        return json(201, { prUrl, discussionUrl });
      },
    },
    {
      // Lets the Share Trip picker show "Suggestions" instead of "Share" for a trip that's
      // already been shared, without a round trip per trip — trip_shares is small, so returning
      // the whole table and matching client-side is simpler than an IN (...) query.
      method: 'GET', path: '/trip/shares', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const rows = await ctx.db.query('SELECT trip_id, pr_url, discussion_url FROM trip_shares');
        return json(200, { shares: rows.map((r) => ({ tripId: r.trip_id, prUrl: r.pr_url, discussionUrl: r.discussion_url })) });
      },
    },
    {
      // Read side of suggestions for a trip you shared yourself — keys off this instance's own
      // trip_shares row.
      method: 'GET', path: '/trip/suggestions', auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.query.tripId);
        if (!Number.isInteger(tripId)) return error(400, 'tripId is required');
        const rows = await ctx.db.query('SELECT * FROM trip_shares WHERE trip_id = ?', tripId);
        if (!rows.length) return json(200, { shared: false, comments: [] });
        const share = rows[0];

        const token = await ctx.settings.get('github_pat');
        if (!token) return json(200, { shared: true, prUrl: share.pr_url, discussionUrl: share.discussion_url, comments: [], needsToken: true });

        let comments = [];
        try {
          const data = await githubGraphQL(
            token,
            `query($owner:String!,$name:String!,$number:Int!){
              repository(owner:$owner,name:$name){
                discussion(number:$number){ comments(first:50){ nodes{ id url body createdAt author{ login } } } }
              }
            }`,
            { owner: GITHUB_OWNER, name: GITHUB_REPO, number: share.discussion_number }
          );
          const nodes = (data.repository.discussion && data.repository.discussion.comments.nodes) || [];
          comments = nodes.map((c) => ({
            id: c.id, author: c.author && c.author.login, body: c.body, createdAt: c.createdAt, url: c.url,
          }));
        } catch (e) {
          return error(502, 'Could not load suggestions: ' + String(e && e.message || e));
        }

        return json(200, { shared: true, prUrl: share.pr_url, discussionUrl: share.discussion_url, comments });
      },
    },
    {
      // Write side — posts a suggestion as a Discussion comment under the poster's own GitHub
      // identity (their own PAT).
      method: 'POST', path: '/trip/suggestions', auth: true,
      async handler(req, ctx) {
        const tripId = Number((req.body || {}).tripId);
        if (!Number.isInteger(tripId)) return error(400, 'tripId is required');
        const body = String((req.body || {}).body || '').trim().slice(0, 2000);
        if (!body) return error(400, 'Suggestion text is required');

        const rows = await ctx.db.query('SELECT * FROM trip_shares WHERE trip_id = ?', tripId);
        if (!rows.length) return error(404, "This trip hasn't been shared yet");
        const share = rows[0];

        const token = await ctx.settings.get('github_pat');
        if (!token) return error(400, "Set your GitHub personal access token in this plugin's settings first.");

        if (!share.discussion_node_id) return error(500, 'This share has no linked discussion to comment on.');

        let comment;
        try {
          const data = await githubGraphQL(
            token,
            `mutation($discussionId:ID!,$body:String!){
              addDiscussionComment(input:{discussionId:$discussionId,body:$body}) {
                comment { id url body createdAt author{ login } }
              }
            }`,
            { discussionId: share.discussion_node_id, body }
          );
          comment = data.addDiscussionComment.comment;
        } catch (e) {
          return error(502, 'Could not post suggestion: ' + String(e && e.message || e));
        }

        return json(201, {
          id: comment.id, author: comment.author && comment.author.login, body: comment.body,
          createdAt: comment.createdAt, url: comment.url,
        });
      },
    },
    {
      // Read side of suggestions for a trip browsed from the Community Trips list — NOT the same
      // as /trip/suggestions above, which keys off this instance's own trip_shares row and only
      // makes sense for a trip YOU shared. Browsing someone ELSE's shared trip has no local
      // trip_shares row for it at all, only the discussionUrl carried in the marketplace
      // index.json entry — so this keys off that URL directly instead.
      method: 'GET', path: '/marketplace/trip-comments', auth: true,
      async handler(req, ctx) {
        const discussionUrl = String(req.query.discussionUrl || '');
        const match = discussionUrl.match(/\/discussions\/(\d+)/);
        if (!match) return error(400, 'A valid discussionUrl is required');
        const discussionNumber = Number(match[1]);

        const token = await ctx.settings.get('github_pat');
        if (!token) return json(200, { comments: [], needsToken: true });

        try {
          const data = await githubGraphQL(
            token,
            `query($owner:String!,$name:String!,$number:Int!){
              repository(owner:$owner,name:$name){
                discussion(number:$number){ comments(first:50){ nodes{ id url body createdAt author{ login } } } }
              }
            }`,
            { owner: GITHUB_OWNER, name: GITHUB_REPO, number: discussionNumber }
          );
          const nodes = (data.repository.discussion && data.repository.discussion.comments.nodes) || [];
          return json(200, {
            comments: nodes.map((c) => ({ id: c.id, author: c.author && c.author.login, body: c.body, createdAt: c.createdAt, url: c.url })),
          });
        } catch (e) {
          return error(502, 'Could not load suggestions: ' + String(e && e.message || e));
        }
      },
    },
    {
      // Write side — same reasoning as above, keyed by discussionUrl rather than a local
      // trip_shares row. Stays admin-only, same as every other write action here; posting uses
      // the poster's own PAT so GitHub attributes the comment to them, not this plugin.
      method: 'POST', path: '/marketplace/trip-comments', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const discussionUrl = String(b.discussionUrl || '');
        const match = discussionUrl.match(/\/discussions\/(\d+)/);
        if (!match) return error(400, 'A valid discussionUrl is required');
        const discussionNumber = Number(match[1]);
        const body = String(b.body || '').trim().slice(0, 2000);
        if (!body) return error(400, 'Suggestion text is required');

        const token = await ctx.settings.get('github_pat');
        if (!token) return error(400, "Set your GitHub personal access token in this plugin's settings first.");

        try {
          const discussionData = await githubGraphQL(
            token,
            `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ discussion(number:$number){ id } } }`,
            { owner: GITHUB_OWNER, name: GITHUB_REPO, number: discussionNumber }
          );
          const discussionId = discussionData.repository.discussion && discussionData.repository.discussion.id;
          if (!discussionId) return error(404, 'Discussion not found');

          const data = await githubGraphQL(
            token,
            `mutation($discussionId:ID!,$body:String!){
              addDiscussionComment(input:{discussionId:$discussionId,body:$body}) {
                comment { id url body createdAt author{ login } }
              }
            }`,
            { discussionId, body }
          );
          const comment = data.addDiscussionComment.comment;
          return json(201, {
            id: comment.id, author: comment.author && comment.author.login, body: comment.body,
            createdAt: comment.createdAt, url: comment.url,
          });
        } catch (e) {
          return error(502, 'Could not post suggestion: ' + String(e && e.message || e));
        }
      },
    },
    {
      // Stores a local, read-only draft copy of a browsed trip — same "lands as a Draft, never
      // auto-published/auto-anything" behavior the old Featured-Guides-hosted import had. `blocks`
      // is exactly the JSON the client already fetched straight from raw.githubusercontent.com
      // (public, keyless) — this route never re-fetches it itself.
      method: 'POST', path: '/trip/import', auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const slug = String(b.slug || '').trim().slice(0, 100);
        const title = String(b.title || 'Untitled trip').trim().slice(0, 200);
        const location = b.location ? String(b.location).trim().slice(0, 200) : null;
        if (!slug) return error(400, 'slug is required');
        if (!Array.isArray(b.blocks)) return error(400, 'blocks must be an array');
        const sourceUpdatedAt = b.sourceUpdatedAt ? String(b.sourceUpdatedAt).slice(0, 40) : null;

        await ctx.db.exec(
          'INSERT INTO imported_trips (slug, title, location, blocks, source_updated_at, imported_by) VALUES (?, ?, ?, ?, ?, ?)',
          slug, title, location, JSON.stringify(b.blocks), sourceUpdatedAt, req.user.name || req.user.email || null
        );
        const rows = await ctx.db.query('SELECT id FROM imported_trips WHERE id = last_insert_rowid()');
        return json(201, { id: rows[0] && rows[0].id });
      },
    },
    {
      // Lists this user's own locally-imported trip drafts, newest first.
      method: 'GET', path: '/trip/imports', auth: true,
      async handler(req, ctx) {
        const rows = await ctx.db.query('SELECT * FROM imported_trips ORDER BY id DESC');
        return json(200, {
          imports: rows.map((r) => ({
            id: r.id, slug: r.slug, title: r.title, location: r.location,
            blocks: JSON.parse(r.blocks || '[]'), sourceUpdatedAt: r.source_updated_at, createdAt: r.created_at,
          })),
        });
      },
    },
    {
      // Query param, not a `/:id` path segment — every other route in this plugin (and in
      // Featured Guides) identifies a resource via ?id=, so this stays consistent rather than
      // introducing the one path-param route in the whole codebase.
      method: 'DELETE', path: '/trip/imports', auth: true,
      async handler(req, ctx) {
        const id = Number(req.query.id);
        if (!Number.isInteger(id)) return error(400, 'A valid id is required');
        await ctx.db.exec('DELETE FROM imported_trips WHERE id = ?', id);
        return json(200, { ok: true });
      },
    },
  ],
});
