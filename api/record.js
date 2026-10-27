const GH_API = "https://api.github.com";

function env(name, fallback = "") {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

async function gh(path, options = {}) {
  const response = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: { ...githubHeaders(), ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  if (!response.ok) {
    const error = new Error(body?.message || `GitHub API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function repoPath(path) {
  const owner = encodeURIComponent(env("GITHUB_OWNER"));
  const repo = encodeURIComponent(env("GITHUB_REPO"));
  return `/repos/${owner}/${repo}${path}`;
}

async function loadDatabase() {
  const branch = env("GITHUB_BRANCH", "main");
  const dataPath = env("GITHUB_DATA_PATH", "aniskip_data.json");
  const ref = await gh(repoPath(`/git/ref/heads/${encodeURIComponent(branch)}`));
  const commit = await gh(repoPath(`/git/commits/${ref.object.sha}`));
  const tree = await gh(repoPath(`/git/trees/${commit.tree.sha}?recursive=1`));
  const entry = tree.tree?.find((item) => item.type === "blob" && item.path === dataPath);
  if (!entry) throw Object.assign(new Error(`Database file not found: ${dataPath}`), { status: 404 });
  const blob = await gh(repoPath(`/git/blobs/${entry.sha}`));
  const json = Buffer.from(blob.content.replace(/\n/g, ""), blob.encoding || "base64").toString("utf8");
  return { database: JSON.parse(json), headSha: ref.object.sha, treeSha: commit.tree.sha, dataPath };
}

function findAnime(database, malId) {
  return Object.entries(database).find(([, anime]) => Number(anime?.malId) === malId) || null;
}

async function animeFromMal(malId) {
  const malClientId = process.env.MAL_CLIENT_ID || "";
  if (!malClientId) {
    throw Object.assign(new Error("MAL_CLIENT_ID is required to query official MyAnimeList API"), { status: 500 });
  }
  let title = "";
  let totalEpisodes = 0;
  let format = "TV";

  try {
    const malUrl = `https://api.myanimelist.net/v2/anime/${malId}?fields=id,title,alternative_titles,num_episodes,media_type`;
    const malRes = await fetch(malUrl, {
      headers: { "X-MAL-CLIENT-ID": malClientId.trim() }
    });
    if (malRes.ok) {
      const malData = await malRes.json();
      const alt = malData.alternative_titles || {};
      title = (alt.en && alt.en.trim()) ? alt.en.trim() : (malData.title || "");
      totalEpisodes = malData.num_episodes || 0;
      format = (malData.media_type || "TV").toUpperCase();
    } else {
      const err = await malRes.json().catch(() => ({}));
      throw new Error(err.message || `MAL API returned ${malRes.status}`);
    }
  } catch (e) {
    throw Object.assign(new Error(`Official MyAnimeList API error for ID ${malId}: ${e.message}`), { status: 404 });
  }

  if (!title) {
    throw Object.assign(new Error(`No anime found on MyAnimeList for MAL ID ${malId}`), { status: 404 });
  }

  return {
    key: String(malId),
    value: {
      anilistId: malId,
      malId,
      title: title || `MAL ${malId}`,
      format: format || "TV",
      totalEpisodes: totalEpisodes || 0,
      episodes: {}
    }
  };
}

function range(value, label, { optional = false } = {}) {
  if (value == null) return null;

  // Crunchyroll sometimes includes an event object even when that event has
  // no usable timestamps (for example { start: null, end: null }). Treat
  // those placeholder skip events as absent instead of failing the whole
  // episode/bulk import. Manual input remains strict.
  const source = Array.isArray(value) ? value[0] : value;
  const rawStart = source?.start ?? source?.startTime ?? source?.start_time;
  const rawEnd = source?.end ?? source?.endTime ?? source?.end_time;
  const start = Number(rawStart);
  const end = Number(rawEnd);
  const supplied = v => (typeof v === 'number' || typeof v === 'string') && String(v).trim() !== '';
  const valid = supplied(rawStart) && supplied(rawEnd) && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;

  if (!valid) {
    if (optional) return null;
    throw Object.assign(new Error(`${label} must have valid start/end seconds`), { status: 400 });
  }
  return { start, end };
}

// Episode identifiers may be fractional for recap/special entries (for
// example 7.5). Normalizing through Number keeps lookup and write keys
// consistent: "7.50", 7.5 and "7.5" all address the same JSON record.
function episodeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function episodeKey(value) {
  const number = episodeNumber(value);
  return number === null ? null : String(number);
}

function send(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function fetchCrunchyroll(mediaId) {
  const id = String(mediaId || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(id)) {
    throw Object.assign(new Error("Invalid Crunchyroll media ID"), { status: 400 });
  }
  const response = await fetch(`https://static.crunchyroll.com/skip-events/production/${encodeURIComponent(id)}.json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Crunchyroll skip data unavailable for ${id} (${response.status})`), { status: response.status === 404 ? 404 : response.status === 429 ? 429 : 502 });
  }
  let data;
  try { data = JSON.parse(await response.text()); }
  catch { throw Object.assign(new Error("Crunchyroll returned a non-JSON response"), { status: 502 }); }
  const op = data.intro ? range(data.intro, "Crunchyroll intro", { optional: true }) : null;
  const ed = data.credits ? range(data.credits, "Crunchyroll credits", { optional: true }) : null;
  if (!op && !ed) throw Object.assign(new Error(`No intro or credits timestamps found for ${id}`), { status: 404 });
  return { requestedMediaId: id, mediaId: data.mediaId || id, op, ed, lastUpdated: data.lastUpdated || null };
}

async function getCrunchyrollToken() {
  const tokenUrl = 'https://beta-api.crunchyroll.com/auth/v1/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic bm9haWhkZXZtXzZpeWcwYThsMHE6',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_id' }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw Object.assign(new Error(`Failed to obtain Crunchyroll guest token (${res.status})`), { status: 502 });
  const data = await res.json();
  return data.access_token;
}

async function resolveCrunchyrollSeries(title) {
  const token = await getCrunchyrollToken();
  const searchUrl = `https://beta-api.crunchyroll.com/content/v2/discover/search?q=${encodeURIComponent(title)}&type=series&n=3`;
  const sRes = await fetch(searchUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!sRes.ok) throw Object.assign(new Error(`Crunchyroll search failed (${sRes.status})`), { status: 502 });
  const sData = await sRes.json();
  const items = sData.data?.[0]?.items || [];
  if (!items.length) throw Object.assign(new Error(`No series found on Crunchyroll for "${title}"`), { status: 404 });
  return { token, series: items };
}

async function fetchCrunchyrollSeasonEpisodes(seasonId, token = null) {
  const authToken = token || await getCrunchyrollToken();
  const epUrl = `https://beta-api.crunchyroll.com/content/v2/cms/seasons/${encodeURIComponent(seasonId)}/episodes`;
  const epRes = await fetch(epUrl, {
    headers: { 'Authorization': `Bearer ${authToken}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!epRes.ok) throw Object.assign(new Error(`Failed to fetch Crunchyroll season episodes (${epRes.status})`), { status: 502 });
  const epData = await epRes.json();
  return epData.data || [];
}

export default async function handler(req, res) {
  try {
    // All writes now pass through the audited, conflict-aware editor API.
    if (req.method === 'POST') {
      const { default: editor } = await import('./editor.js');
      return editor(req, res);
    }
    if (req.method === "GET") {
      // Endpoint 1: Direct Media ID single skip lookup
      if (req.query.mode === "crunchyroll") {
        const result = await fetchCrunchyroll(req.query.mediaId);
        return send(res, 200, { ok: true, ...result });
      }

      // Endpoint 2: Auto-Resolve Crunchyroll Series & Seasons by Anime Title or MAL ID
      if (req.query.mode === "crunchyroll-resolve") {
        let title = String(req.query.title || "").trim();
        const malId = Number(req.query.malId);
        if (!title && malId > 0) {
          const malObj = await animeFromMal(malId);
          title = malObj.value?.title || "";
        }
        if (!title) return send(res, 400, { ok: false, error: "Title or valid MAL ID required to resolve Crunchyroll series." });

        const { token, series } = await resolveCrunchyrollSeries(title);
        const topSeries = series[0];
        
        // Fetch seasons for the top matched series
        const seasonsUrl = `https://beta-api.crunchyroll.com/content/v2/cms/series/${encodeURIComponent(topSeries.id)}/seasons`;
        const sRes = await fetch(seasonsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        const seasons = sRes.ok ? ((await sRes.json()).data || []) : [];

        return send(res, 200, {
          ok: true,
          resolvedTitle: title,
          seriesTitle: topSeries.title,
          seriesId: topSeries.id,
          seasons: seasons.map(s => ({
            id: s.id,
            title: s.title,
            season_number: s.season_number,
            is_subbed: s.is_subbed,
            audioLocale: s.audio_locale || s.audioLocale || ""
          })),
          series: {
            id: topSeries.id,
            title: topSeries.title,
            description: topSeries.description,
            seasons: seasons.map(s => ({
              id: s.id,
              title: s.title,
              season_number: s.season_number,
              is_subbed: s.is_subbed
            }))
          }
        });
      }

      // Endpoint 3: Full Season Batch Episodes Fetcher
      if (req.query.mode === "crunchyroll-season") {
        const seasonId = String(req.query.seasonId || "").trim();
        if (!seasonId) return send(res, 400, { ok: false, error: "seasonId is required." });
        const episodes = await fetchCrunchyrollSeasonEpisodes(seasonId);
        return send(res, 200, { ok: true, seasonId, count: episodes.length, episodes });
      }
      const malId = Number(req.query.malId);
      if (!Number.isInteger(malId) || malId <= 0) return send(res, 400, { ok: false, error: "A valid malId is required" });
      const { database } = await loadDatabase();
      const found = findAnime(database, malId);
      if (req.query.mode === "missing") {
        if (!found) return send(res, 404, { ok: false, error: `MAL ID ${malId} is not in the database` });
        const anime = found[1];
        const storedEpisodes = Object.keys(anime.episodes || {}).map(Number).filter(Number.isInteger);
        const maxStored = storedEpisodes.length ? Math.max(...storedEpisodes) : 0;
        const requestedThrough = Number(req.query.through);
        const through = Number.isInteger(requestedThrough) && requestedThrough > 0
          ? requestedThrough
          : Math.max(Number(anime.totalEpisodes) || 0, maxStored);
        if (through > 5000) return send(res, 400, { ok: false, error: 'Check 5000 episodes or fewer at a time' });
        const items = [];
        for (let number = 1; number <= through; number += 1) {
          const record = anime.episodes?.[String(number)] || null;
          const missing = [];
          if (!record?.op && !record?.opAbsent) missing.push("op");
          if (!record?.ed && !record?.edAbsent) missing.push("ed");
          if (missing.length) items.push({ episode: number, missing, record });
        }
        return send(res, 200, {
          ok: true,
          anime: anime.title,
          malId,
          through,
          totalEpisodes: anime.totalEpisodes ?? null,
          maxStored,
          count: items.length,
          items
        });
      }
      const episode = episodeNumber(req.query.episode);
      const key = episodeKey(req.query.episode);
      if (episode === null || key === null) return send(res, 400, { ok: false, error: "A valid positive episode number is required" });
      const record = found?.[1]?.episodes?.[key] || null;
      return send(res, 200, { ok: true, exists: Boolean(record), anime: found?.[1]?.title || null, record });
    }

    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return send(res, error.status || 500, { ok: false, error: error.message || 'Unexpected server error' });
  }
}
export { env, gh, repoPath, loadDatabase, findAnime, animeFromMal, range, episodeNumber, episodeKey, fetchCrunchyroll, send };