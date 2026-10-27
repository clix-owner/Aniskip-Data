import fs from "node:fs";
import path from "node:path";

// 1. String Normalizer & Levenshtein Distance for strict Title Matching
function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const an = a ? a.length : 0;
  const bn = b ? b.length : 0;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: bn + 1 }, (_, i) => [i]);
  for (let i = 0; i <= an; i++) matrix[0][i] = i;
  for (let i = 1; i <= bn; i++) {
    for (let j = 1; j <= an; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[bn][an];
}

export function titleSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (!na || !nb) return 0.0;
  if (na.includes(nb) || nb.includes(na)) {
    const minLen = Math.min(na.length, nb.length);
    const maxLen = Math.max(na.length, nb.length);
    if (minLen / maxLen >= 0.75) return 0.95;
  }
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

// 2. Crunchyroll Guest Token
export async function getCrunchyrollToken() {
  const authUrl = "https://beta-api.crunchyroll.com/auth/v1/token";
  const authRes = await fetch(authUrl, {
    method: "POST",
    headers: {
      "Authorization": "Basic bm9haWhkZXZtXzZpeWcwYThsMHE6",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_id"
  });
  if (!authRes.ok) throw new Error(`Crunchyroll token error: ${authRes.status}`);
  const authData = await authRes.json();
  return authData.access_token;
}

// 3. Crunchyroll Series Resolution with High-Confidence Match
export async function searchCrunchyrollSeries(token, queryTitle) {
  const searchUrl = `https://beta-api.crunchyroll.com/content/v2/discover/search?q=${encodeURIComponent(queryTitle)}&type=series&n=6`;
  const res = await fetch(searchUrl, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!res.ok) return [];
  const data = await res.json();
  const items = data.data?.[0]?.items || [];
  return items.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    similarity: titleSimilarity(queryTitle, s.title)
  })).sort((a, b) => b.similarity - a.similarity);
}

// 4. Fetch Seasons and Filter Out Non-Canonical / Dubs
export async function getSeasons(token, seriesId) {
  const seasonsUrl = `https://beta-api.crunchyroll.com/content/v2/cms/series/${encodeURIComponent(seriesId)}/seasons`;
  const res = await fetch(seasonsUrl, { headers: { "Authorization": `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

// 5. Fetch Season Episodes
export async function getSeasonEpisodes(token, seasonId) {
  const epUrl = `https://beta-api.crunchyroll.com/content/v2/cms/seasons/${encodeURIComponent(seasonId)}/episodes`;
  const res = await fetch(epUrl, { headers: { "Authorization": `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

// 6. 100% Reliable Special & OVA Filter (Preserving Canonical 1..N Episodes)
export function filterNormalEpisodes(episodes) {
  const markerSpecial = (item) => {
    const label = String(item?.episode || "").trim().toUpperCase();
    const title = String(item?.title || "").trim();
    const numericLabel = Number(label);
    const fractionalEpisode = Number.isFinite(numericLabel) && !Number.isInteger(numericLabel);
    return fractionalEpisode || /^SP(?:[0-9]+)?$/.test(label) || label === "RECAP" || label === "SPECIAL" || /^SPECIAL EPISODE\s*:/i.test(title);
  };

  const seasonBase = (seasonId) => String(seasonId || "").trim().replace(/(?:[A-Z]{4}|[A-Z]{2}\d{3})$/i, "");
  const seasonCounts = new Map();
  for (const item of episodes) {
    if (markerSpecial(item) || !item?.season_id) continue;
    const key = seasonBase(item.season_id);
    if (key) seasonCounts.set(key, (seasonCounts.get(key) || 0) + 1);
  }
  const mainSeasonId = [...seasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const belongsToMainSeason = (item) => !mainSeasonId || !item?.season_id || seasonBase(item.season_id) === mainSeasonId;

  const mainSeasonCandidates = episodes
    .filter(item => !markerSpecial(item) && belongsToMainSeason(item))
    .sort((a, b) => Number(a?.sequence_number) - Number(b?.sequence_number));

  const contextualSpecials = new Set();
  if (mainSeasonCandidates.length >= 3) {
    const [first, ...rest] = mainSeasonCandidates;
    const firstNumber = Number(first?.episode_number ?? first?.episode);
    const restNumbers = rest.map(item => Number(item?.episode_number ?? item?.episode));
    const restIsContiguous = restNumbers.every((number, index) => Number.isInteger(number) && (index === 0 || number === restNumbers[index - 1] + 1));
    if (Number.isInteger(firstNumber) && restIsContiguous && restNumbers[0] > firstNumber + 1) contextualSpecials.add(first);
  }

  const isSpecial = (item) => markerSpecial(item) || !belongsToMainSeason(item) || contextualSpecials.has(item);

  const mediaIdFor = (item) => {
    const versions = Array.isArray(item?.versions) ? item.versions : [];
    const original = versions.find(v => v?.original === true && String(v?.guid || "").trim())
      || versions.find(v => v?.audio_locale === "ja-JP" && String(v?.guid || "").trim());
    return String(original?.guid || item?.id || "").trim();
  };

  const normalEpisodes = episodes.filter(item => !isSpecial(item));
  const result = [];
  for (const item of normalEpisodes) {
    const epNum = Number(item.episode_number ?? item.sequence_number ?? item.episode);
    const mediaId = mediaIdFor(item);
    if (Number.isInteger(epNum) && epNum > 0 && mediaId) {
      result.push({
        episodeNumber: epNum,
        mediaId,
        title: item.title || ""
      });
    }
  }
  return result.sort((a, b) => a.episodeNumber - b.episodeNumber);
}

// 7. Crunchyroll Official CDN Skip Event Fetcher
export async function fetchCrunchyrollSkip(mediaId) {
  const url = `https://static.crunchyroll.com/skip-events/production/${encodeURIComponent(mediaId)}.json`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  const parseRange = (val) => {
    if (!val) return null;
    const start = Number(val.start ?? val.startTime);
    const end = Number(val.end ?? val.endTime);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
      return { start, end };
    }
    return null;
  };
  const op = parseRange(data?.intro);
  const ed = parseRange(data?.credits);
  if (!op && !ed) return null; // No usable skip events yet
  const rec = {};
  if (op) rec.op = op;
  if (ed) rec.ed = ed;
  return rec;
}

// 8. Main Auto-Sync Execution Routine
export async function syncAnimeEpisodes({ dbPath, malId, title, dryRun = false }) {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  let animeEntry = db[String(malId)];

  // If anime does not exist in DB, create new structure
  if (!animeEntry) {
    console.log(`[SYNC] MAL ID ${malId} ("${title}") is NEW. Creating entry in database...`);
    animeEntry = {
      anilistId: Number(malId),
      malId: Number(malId),
      title: title || `MAL ${malId}`,
      format: "TV",
      totalEpisodes: 0,
      episodes: {}
    };
    if (!dryRun) db[String(malId)] = animeEntry;
  }

  const existingEpisodes = new Set(Object.keys(animeEntry.episodes || {}));
  console.log(`[SYNC] ${animeEntry.title} (MAL ${malId}): currently has ${existingEpisodes.size} episodes in DB.`);

  const token = await getCrunchyrollToken();
  const searchResults = await searchCrunchyrollSeries(token, animeEntry.title);
  if (!searchResults.length || searchResults[0].similarity < 0.75) {
    console.log(`[SYNC] High-confidence Crunchyroll match NOT found for "${animeEntry.title}". Skipping to avoid false positives.`);
    return { addedCount: 0, skipped: true };
  }

  const bestSeries = searchResults[0];
  console.log(`[SYNC] Matched Crunchyroll Series: "${bestSeries.title}" (${bestSeries.id}) - Confidence: ${(bestSeries.similarity * 100).toFixed(1)}%`);

  const seasons = await getSeasons(token, bestSeries.id);
  const jaSeason = seasons.find(s => s.audio_locale === "ja-JP" || s.audioLocale === "ja-JP") || seasons[0];
  if (!jaSeason) {
    console.log(`[SYNC] No seasons found for series ${bestSeries.id}.`);
    return { addedCount: 0, skipped: true };
  }

  const allEpisodes = await getSeasonEpisodes(token, jaSeason.id);
  const normalEps = filterNormalEpisodes(allEpisodes);
  console.log(`[SYNC] Filtered ${normalEps.length} normal/canonical episodes (specials/OVAs excluded).`);

  // Detect missing/new episodes
  const missingEps = normalEps.filter(e => !existingEpisodes.has(String(e.episodeNumber)));
  if (!missingEps.length) {
    console.log(`[SYNC] All ${normalEps.length} episodes are already present in DB. Up to date!`);
    return { addedCount: 0, upToDate: true };
  }

  console.log(`[SYNC] Found ${missingEps.length} new episode(s) to ingest: ${missingEps.map(e => `E${e.episodeNumber}`).join(", ")}`);
  let addedCount = 0;

  for (const ep of missingEps) {
    const timestamps = await fetchCrunchyrollSkip(ep.mediaId);
    if (timestamps) {
      console.log(`  [+] Ep ${ep.episodeNumber} (${ep.mediaId}): Found timestamps -> OP: ${Boolean(timestamps.op)}, ED: ${Boolean(timestamps.ed)}`);
      if (!dryRun) {
        animeEntry.episodes[String(ep.episodeNumber)] = timestamps;
      }
      addedCount++;
    } else {
      console.log(`  [-] Ep ${ep.episodeNumber} (${ep.mediaId}): Crunchyroll skip-events not yet tagged on CDN. Will retry next run.`);
    }
  }

  if (addedCount > 0 && !dryRun) {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
    console.log(`[SYNC] Successfully appended ${addedCount} new episode(s) to ${dbPath}.`);
  }

  return { addedCount, totalMissing: missingEps.length };
}