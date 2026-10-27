import fs from "node:fs";
import path from "node:path";
import {
  getCrunchyrollToken,
  searchCrunchyrollSeries,
  getSeasons,
  getSeasonEpisodes,
  filterNormalEpisodes,
  fetchCrunchyrollSkip,
  syncAnimeEpisodes
} from "./auto-sync.mjs";

const DB_PATH = path.resolve("data/aniskip_data.json");
const HISTORY_PATH = path.resolve("data/editor-history.json");

// Discover currently airing anime from Official MAL API v2
async function fetchAiringAnime(limit = 50) {
  const malClientId = process.env.MAL_CLIENT_ID || "";
  if (!malClientId) {
    console.error("[CRON] MAL_CLIENT_ID is not configured in environment.");
    return [];
  }
  try {
    const url = `https://api.myanimelist.net/v2/anime/ranking?ranking_type=airing&limit=${limit}&fields=id,title,alternative_titles,num_episodes,media_type`;
    const res = await fetch(url, {
      headers: { "X-MAL-CLIENT-ID": malClientId.trim() }
    });
    if (!res.ok) {
      console.error("[CRON] MAL ranking API failed:", res.status);
      return [];
    }
    const data = await res.json();
    return (data.data || [])
      .map(entry => entry.node)
      .filter(m => m && m.id && m.media_type !== "movie")
      .map(m => {
        const alt = m.alternative_titles || {};
        return {
          malId: m.id,
          title: (alt.en && alt.en.trim()) ? alt.en.trim() : (m.title || ""),
          format: (m.media_type || "TV").toUpperCase()
        };
      });
  } catch (err) {
    console.error("[CRON] Error fetching airing anime from MAL:", err.message);
    return [];
  }
}

// Write history audit entry if changes occurred
function appendAuditHistory(changes) {
  if (!changes.length) return;
  let history = { entries: [] };
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    } catch {}
  }
  for (const c of changes) {
    history.entries.unshift({
      id: `auto_${Date.now()}_${c.malId}`,
      at: new Date().toISOString(),
      action: "auto/cron-sync",
      malId: c.malId,
      title: c.title,
      count: c.addedCount,
      changes: c.episodes.map(ep => ({
        episode: ep,
        source: "crunchyroll/auto-sync",
        after: "synced timestamps"
      }))
    });
  }
  // Keep last 250 history entries
  if (history.entries.length > 250) history.entries = history.entries.slice(0, 250);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
}

async function main() {
  console.log("=== [START] Clixarena Automated Crunchyroll Skip Sync Engine ===");
  const airingList = await fetchAiringAnime(1, 40);
  console.log(`[CRON] Discovered ${airingList.length} currently airing shows.`);

  let totalUpdatedAnime = 0;
  let totalUpdatedEpisodes = 0;
  const auditChanges = [];

  for (const anime of airingList) {
    try {
      console.log(`\n--- Checking: ${anime.title} (MAL ID: ${anime.malId}) ---`);
      const result = await syncAnimeEpisodes({
        dbPath: DB_PATH,
        malId: anime.malId,
        title: anime.title,
        dryRun: false
      });

      if (result.addedCount > 0) {
        totalUpdatedAnime++;
        totalUpdatedEpisodes += result.addedCount;
        auditChanges.push({
          malId: anime.malId,
          title: anime.title,
          addedCount: result.addedCount,
          episodes: Array.from({ length: result.addedCount }, (_, i) => `+${i + 1}`)
        });
      }
    } catch (err) {
      console.error(`[ERROR] Sync failed for ${anime.title} (MAL ${anime.malId}):`, err.message);
    }
  }

  if (auditChanges.length > 0) {
    appendAuditHistory(auditChanges);
    console.log(`\n[CRON] Audit trail saved to ${HISTORY_PATH}`);
  }

  console.log("\n========================================================");
  console.log(`[COMPLETED] Auto-Sync finished: ${totalUpdatedAnime} anime updated with ${totalUpdatedEpisodes} new episode(s).`);
  console.log("========================================================");
}

main().catch(err => {
  console.error("[FATAL] Auto-sync runner encountered fatal error:", err);
  process.exit(1);
});