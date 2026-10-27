import fs from "node:fs";
import path from "node:path";
import { getCrunchyrollToken, fetchCrunchyrollSkip, titleSimilarity } from "./auto-sync.mjs";

const DB_PATH = path.resolve("data/aniskip_data.json");
const HISTORY_PATH = path.resolve("data/editor-history.json");

// 1. Fetch newly released episodes feed directly from Crunchyroll (videos/new)
export async function fetchCrunchyrollNewReleases(limit = 100) {
  const token = await getCrunchyrollToken();
  const url = `https://beta-api.crunchyroll.com/content/v2/discover/browse?sort_by=newly_added&type=episode&n=${limit}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Crunchyroll newly_added feed error: ${res.status}`);
  const data = await res.json();
  const rawEpisodes = data.data || [];

  const unique = [];
  const seen = new Set();

  for (const ep of rawEpisodes) {
    const meta = ep.episode_metadata || {};
    const epNum = Number(meta.episode_number ?? meta.episode);
    const seriesTitle = meta.series_title;
    if (!Number.isInteger(epNum) || epNum <= 0 || !seriesTitle) continue;

    // Filter out obvious specials/recaps
    const epLabel = String(meta.episode || "").toUpperCase();
    if (epLabel.includes("SP") || epLabel === "RECAP" || epLabel === "SPECIAL") continue;

    // Find original / Japanese version guid
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const orig = versions.find(v => v.original === true) || versions.find(v => v.audio_locale === "ja-JP");
    const mediaId = String(orig?.guid || ep.id).trim();
    if (!mediaId) continue;

    const key = `${seriesTitle}_S${meta.season_number || 1}_E${epNum}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({
        mediaId,
        seriesTitle,
        seasonTitle: meta.season_title || "",
        seasonNumber: meta.season_number || 1,
        episodeNumber: epNum,
        title: ep.title || `Episode ${epNum}`
      });
    }
  }

  return unique;
}

// 2. Resolve MAL ID for Series Title using Local Database or Official MAL Search
export async function resolveMalIdForSeries(seriesTitle, localDb) {
  // Check local database first
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const target = norm(seriesTitle);

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

  // If not found in local DB and MAL_CLIENT_ID exists, search official MAL API
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

// 3. Sync New Releases (Batch 100)
export async function syncNewReleases(limit = 100, dryRun = false) {
  console.log(`[SYNC-NEW] Fetching latest ${limit} episodes from Crunchyroll (videos/new)...`);
  const episodes = await fetchCrunchyrollNewReleases(limit);
  console.log(`[SYNC-NEW] Filtered ${episodes.length} unique canonical episodes.`);

  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  let addedCount = 0;
  const changes = [];

  for (const ep of episodes) {
    try {
      const match = await resolveMalIdForSeries(ep.seriesTitle, db);
      if (!match) {
        continue; // Could not safely align with a MAL anime
      }

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
        continue; // Already has timestamps for this episode
      }

      // Fetch skip timestamps from Crunchyroll Official CDN
      const skip = await fetchCrunchyrollSkip(ep.mediaId);
      if (!skip) {
        continue; // No skip events tagged on CDN yet
      }

      console.log(`  [+] New Episode Ingested: ${match.title} (MAL ${match.malId}) Ep ${ep.episodeNumber} (${ep.mediaId}) -> OP: ${Boolean(skip.op)}, ED: ${Boolean(skip.ed)}`);
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
      id: `new_releases_${Date.now()}`,
      at: new Date().toISOString(),
      action: "auto/crunchyroll-new-releases",
      count: addedCount,
      changes: changes.map(c => ({
        malId: c.malId,
        title: c.title,
        episode: c.episode,
        mediaId: c.mediaId,
        source: "crunchyroll/videos-new",
        after: "synced timestamps"
      }))
    });
    if (history.length > 250) history = history.slice(0, 250);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
    console.log(`[SYNC-NEW] Saved ${addedCount} new episode skip timestamps to database.`);
  } else {
    console.log(`[SYNC-NEW] Database is already up to date with Crunchyroll new releases.`);
  }

  return { addedCount, totalChecked: episodes.length };
}

// Self-run when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/sync-new-releases.mjs")) {
  syncNewReleases(100).catch(err => {
    console.error("[FATAL] sync-new-releases error:", err);
    process.exit(1);
  });
}