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

// Discover currently airing anime from AniList (with MAL IDs)
async function fetchAiringAnime(page = 1, perPage = 30) {
  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(status: RELEASING, type: ANIME, sort: POPULARITY_DESC) {
          id
          idMal
          title { romaji english }
          format
          episodes
        }
      }
    }
  `;
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { page, perPage } })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data?.Page?.media || [])
      .filter(m => m.idMal && m.format !== "MOVIE")
      .map(m => ({
        malId: m.idMal,
        title: m.title?.english || m.title?.romaji,
        format: m.format
      }));
  } catch (err) {
    console.error("[CRON] Error fetching airing anime:", err.message);
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