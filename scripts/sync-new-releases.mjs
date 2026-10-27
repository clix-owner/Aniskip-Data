import fs from "node:fs";
import path from "node:path";
import { getCrunchyrollToken, fetchCrunchyrollSkip, titleSimilarity } from "./auto-sync.mjs";

const DB_PATH = path.resolve("data/aniskip_data.json");
const HISTORY_PATH = path.resolve("data/editor-history.json");

// 1. Fetch newly released episodes from Crunchyroll with a strict 5-day cutoff window & zero duplicates
export async function fetchCrunchyrollNewReleases(days = 5, maxPages = 10) {
  const token = await getCrunchyrollToken();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(`[SYNC-5D] Fetching Crunchyroll new releases from the past ${days} days (cutoff: ${cutoff.toISOString()})...`);

  const uniqueEpisodes = [];
  const seen = new Set();
  let page = 0;

  for (let start = 0; page < maxPages; start += 100, page++) {
    const url = `https://beta-api.crunchyroll.com/content/v2/discover/browse?sort_by=newly_added&type=episode&n=100&start=${start}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.warn(`[SYNC-5D] Page ${page + 1} fetch stopped with status ${res.status}`);
      break;
    }
    const data = await res.json();
    const batch = data.data || [];
    if (!batch.length) break;

    let reachedPastCutoff = false;

    for (const ep of batch) {
      const meta = ep.episode_metadata || {};
      const epNum = Number(meta.episode_number ?? meta.episode);
      const seriesTitle = meta.series_title;
      if (!Number.isInteger(epNum) || epNum <= 0 || !seriesTitle) continue;

      // Filter out specials and recaps
      const epLabel = String(meta.episode || "").toUpperCase();
      if (epLabel.includes("SP") || epLabel === "RECAP" || epLabel === "SPECIAL") continue;

      // Release date check against 5 days window
      const dateStr = meta.premium_available_date || meta.upload_date;
      if (dateStr && new Date(dateStr) < cutoff) {
        reachedPastCutoff = true;
        continue;
      }

      // Unique Canonical Key (Series + Season + EpisodeNumber) - prevents ANY duplicate
      const canonicalKey = `${seriesTitle.toLowerCase().trim()}_s${meta.season_number || 1}_e${epNum}`;
      if (seen.has(canonicalKey)) continue;
      seen.add(canonicalKey);

      // Extract Japanese original track / guid
      const versions = Array.isArray(meta.versions) ? meta.versions : [];
      const orig = versions.find(v => v.original === true) || versions.find(v => v.audio_locale === "ja-JP");
      const mediaId = String(orig?.guid || ep.id).trim();
      if (!mediaId) continue;

      uniqueEpisodes.push({
        mediaId,
        seriesTitle,
        seasonTitle: meta.season_title || "",
        seasonNumber: meta.season_number || 1,
        episodeNumber: epNum,
        title: ep.title || `Episode ${epNum}`,
        date: dateStr
      });
    }

    if (reachedPastCutoff && page >= 3) {
      console.log(`[SYNC-5D] Reached beyond ${days}-day release threshold at page ${page + 1}.`);
      break;
    }
  }

  return uniqueEpisodes;
}

// 2. Resolve MAL ID for Series Title using Local Database or Official MAL Search
export async function resolveMalIdForSeries(seriesTitle, localDb) {
  let bestMatch = null;
  let highestScore = 0;

  for (const anime of Object.values(localDb)) {
    const score = titleSimilarity(seriesTitle, anime.title);
    if (score > highestScore) {
      highestScore = score;
      bestMatch = anime;
    }
    if (score >= 0.95) break;
  }

  if (bestMatch && highestScore >= 0.75) {
    return { malId: bestMatch.malId, title: bestMatch.title, stored: true };
  }

  // Official MyAnimeList (MAL) API v2 fallback if MAL_CLIENT_ID exists
  const malClientId = process.env.MAL_CLIENT_ID || "";
  if (malClientId) {
    try {
      const malUrl = `https://api.myanimelist.net/v2/anime?q=${encodeURIComponent(seriesTitle)}&limit=5&fields=id,title,alternative_titles,num_episodes`;
      const malRes = await fetch(malUrl, {
        headers: { "X-MAL-CLIENT-ID": malClientId.trim() },
        signal: AbortSignal.timeout(6000)
      });
      if (malRes.ok) {
        const malData = await malRes.json();
        const top = malData.data?.[0]?.node;
        if (top) {
          const alt = top.alternative_titles || {};
          const t = (alt.en && alt.en.trim()) ? alt.en.trim() : (top.title || "");
          const score = titleSimilarity(seriesTitle, t);
          if (score >= 0.70) {
            return { malId: top.id, title: t, stored: false };
          }
        }
      }
    } catch (err) {}
  }

  return null;
}

// 3. Sync All 5-Day Releases into aniskip_data.json
export async function syncNewReleases(days = 5, dryRun = false) {
  const episodes = await fetchCrunchyrollNewReleases(days);
  console.log(`[SYNC-5D] Found ${episodes.length} unique canonical episodes released in the last ${days} days.`);

  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  let addedCount = 0;
  const changes = [];

  for (const ep of episodes) {
    try {
      const match = await resolveMalIdForSeries(ep.seriesTitle, db);
      if (!match) continue; // Skip if no high-confidence MAL match

      let animeEntry = db[String(match.malId)];
      if (!animeEntry) {
        animeEntry = {
          anilistId: match.malId,
          malId: match.malId,
          title: match.title,
          format: "TV",
          totalEpisodes: 0,
          episodes: {}
        };
        if (!dryRun) db[String(match.malId)] = animeEntry;
      }

      const epKey = String(ep.episodeNumber);
      if (animeEntry.episodes[epKey]) {
        continue; // Already ingested
      }

      const skip = await fetchCrunchyrollSkip(ep.mediaId);
      if (!skip) {
        continue; // No skip events available yet on CDN
      }

      console.log(`  [+] Ingested 5-day release: ${match.title} (MAL ${match.malId}) Ep ${ep.episodeNumber} -> OP: ${Boolean(skip.op)}, ED: ${Boolean(skip.ed)}`);
      if (!dryRun) {
        animeEntry.episodes[epKey] = skip;
      }
      addedCount++;
      changes.push({
        malId: match.malId,
        title: match.title,
        episode: ep.episodeNumber,
        mediaId: ep.mediaId
      });
    } catch (err) {
      console.warn(`[WARN] Failed to process ${ep.seriesTitle} Ep ${ep.episodeNumber}:`, err.message);
    }
  }

  if (addedCount > 0 && !dryRun) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");

    // Write audit history
    let history = [];
    if (fs.existsSync(HISTORY_PATH)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
        history = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
      } catch {}
    }
    history.unshift({
      id: `new_5days_${Date.now()}`,
      at: new Date().toISOString(),
      action: `auto/crunchyroll-5days-sync`,
      count: addedCount,
      changes: changes.map(c => ({
        malId: c.malId,
        title: c.title,
        episode: c.episode,
        mediaId: c.mediaId,
        source: "crunchyroll/videos-new-5days",
        after: "synced timestamps"
      }))
    });
    if (history.length > 250) history = history.slice(0, 250);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
    console.log(`[SYNC-5D] Successfully saved ${addedCount} newly released episodes to database.`);
  } else {
    console.log(`[SYNC-5D] Database is already fully up to date with past ${days} days releases.`);
  }

  return { addedCount, totalChecked: episodes.length, days };
}

// Self-run when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/sync-new-releases.mjs")) {
  syncNewReleases(5).catch(err => {
    console.error("[FATAL] sync-new-releases error:", err);
    process.exit(1);
  });
}