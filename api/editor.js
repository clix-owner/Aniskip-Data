import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { env, gh, repoPath, loadDatabase, findAnime, animeFromMal, range, episodeNumber, fetchCrunchyroll, send } from './record.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function same(a, b) { return isDeepStrictEqual(a ?? null, b ?? null); }
export function complete(record) { return Boolean((record?.op || record?.opAbsent) && (record?.ed || record?.edAbsent)); }
export function mergeRecord(previous, patch) {
  const record = { ...(previous || {}) };
  for (const field of ['op', 'ed']) {
    if (patch[`${field}Absent`] === true) { delete record[field]; record[`${field}Absent`] = true; }
    else if (patch[field] != null) { record[field] = range(patch[field], field); delete record[`${field}Absent`]; }
    else if (patch[`${field}Absent`] === false) { delete record[`${field}Absent`]; }
  }
  return record;
}
function authenticate(req) {
  const supplied = Buffer.from(String(req.headers['x-admin-key'] || req.body?.adminKey || ''));
  const expected = Buffer.from(env('ADMIN_KEY'));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail('Invalid admin key', 401);
}
async function historyAt(treeSha) {
  const path = env('GITHUB_HISTORY_PATH', 'data/editor-history.json');
  const tree = await gh(repoPath(`/git/trees/${treeSha}?recursive=1`));
  const entry = tree.tree?.find(x => x.path === path && x.type === 'blob');
  if (!entry) return { path, entries: [] };
  const blob = await gh(repoPath(`/git/blobs/${entry.sha}`));
  const entries = JSON.parse(Buffer.from(blob.content.replace(/\n/g, ''), blob.encoding || 'base64').toString('utf8'));
  if (!Array.isArray(entries)) throw fail('Invalid history file', 500);
  return { path, entries };
}
async function commitChanges(loaded, history, entry) {
  if (history.path === loaded.dataPath) throw fail('History path must differ from database path', 500);
  const files = [{ path: loaded.dataPath, content: loaded.database }, { path: history.path, content: [...history.entries, entry] }];
  const treeEntries = await Promise.all(files.map(async file => {
    const blob = await gh(repoPath('/git/blobs'), { method: 'POST', body: JSON.stringify({ content: Buffer.from(JSON.stringify(file.content, null, 2) + '\n').toString('base64'), encoding: 'base64' }) });
    return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const tree = await gh(repoPath('/git/trees'), { method: 'POST', body: JSON.stringify({ base_tree: loaded.treeSha, tree: treeEntries }) });
  const commit = await gh(repoPath('/git/commits'), { method: 'POST', body: JSON.stringify({ message: `${entry.action} MAL ${entry.malId}: ${entry.changes.length} episode records [${entry.id}]`, tree: tree.sha, parents: [loaded.headSha] }) });
  await gh(repoPath(`/git/refs/heads/${encodeURIComponent(env('GITHUB_BRANCH', 'main'))}`), { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
  return commit.sha;
}
export async function applyRecords(malId, items, action = 'Update', undoOf = null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const loaded = await loadDatabase();
    const history = await historyAt(loaded.treeSha);
    if (undoOf && history.entries.some(x => x.undoOf === undoOf)) throw fail('This change has already been undone', 409);
    let found = findAnime(loaded.database, malId);
    if (!found) {
      const created = await animeFromMal(malId);
      if (loaded.database[created.key] && loaded.database[created.key].malId !== malId) throw fail('AniList ID collision', 409);
      found = [created.key, created.value]; loaded.database[created.key] = created.value;
    }
    const anime = found[1]; anime.episodes ||= {};
    const changes = [], records = [];
    for (const item of items) {
      const key = String(item.episode), before = anime.episodes[key] ?? null;
      const after = item.restore !== undefined ? item.restore : mergeRecord(before, item.patch);
      // An uncertain network result can safely be retried: the same resulting
      // record is a no-op. A different intervening edit must be reviewed.
      if (same(before, after)) { records.push({ episode: item.episode, record: after, unchanged: true }); continue; }
      if (!same(before, item.expected)) throw fail(`Episode ${key} changed since preview. Refresh it before saving.`, 409);
      if (after === null) delete anime.episodes[key]; else anime.episodes[key] = after;
      changes.push({ episode: item.episode, before, after, source: item.source || 'manual', mediaId: item.mediaId || null });
      records.push({ episode: item.episode, record: after, complete: complete(after) });
    }
    if (!changes.length) return { ok: true, count: 0, records, unchanged: true, anime: anime.title };
    // totalEpisodes describes the series, not the latest imported record.
    const entry = { id: randomUUID(), at: new Date().toISOString(), malId, title: anime.title, action, undoOf, changes };
    try {
      const commit = await commitChanges(loaded, history, entry);
      return { ok: true, count: changes.length, records, commit, historyId: entry.id, anime: anime.title };
    } catch (error) { if (![409, 422].includes(error.status) || attempt === 2) throw error; }
  }
}
export default async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
    authenticate(req);
    const body = req.body || {}, mode = req.method === 'GET' ? req.query.mode : body.mode;
    if (mode === 'search') {
      const query = String(req.query.q || '').trim();
      if (query.length < 2 || query.length > 100) throw fail('Enter 2–100 characters');
      const { database } = await loadDatabase();
      const results = Object.values(database).filter(a => a.title?.toLowerCase().includes(query.toLowerCase())).slice(0, 30).map(a => ({ malId: a.malId, anilistId: a.anilistId, title: a.title, totalEpisodes: a.totalEpisodes, stored: true }));
      if (req.query.remote === '1') {
        const response = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ query: 'query($search:String){Page(perPage:20){media(search:$search,type:ANIME){id idMal episodes title{english romaji}}}}', variables: { search: query } }) });
        if (!response.ok) throw fail(`Anime search unavailable (${response.status})`, 502);
        const data = await response.json();
        if (data.errors) throw fail('Anime search returned an error', 502);
        for (const a of data.data?.Page?.media || []) if (a.idMal && !results.some(x => x.malId === a.idMal)) results.push({ malId: a.idMal, anilistId: a.id, title: a.title.english || a.title.romaji, totalEpisodes: a.episodes, stored: false });
      }
      return send(res, 200, { ok: true, results });
    }
    if (mode === 'history') {
      const loaded = await loadDatabase(), history = await historyAt(loaded.treeSha);
      const malId = Number(req.query.malId);
      return send(res, 200, { ok: true, entries: history.entries.filter(x => !malId || x.malId === malId).slice(-100).reverse() });
    }
    const malId = Number(body.malId ?? req.query.malId);
    if (!Number.isInteger(malId) || malId <= 0) throw fail('A valid MAL ID is required');
    if (mode === 'undo') {
      const loaded = await loadDatabase(), history = await historyAt(loaded.treeSha);
      const entry = history.entries.find(x => x.id === body.historyId && x.malId === malId);
      if (!entry) throw fail('History entry not found', 404);
      if (entry.undoOf || history.entries.some(x => x.undoOf === entry.id)) throw fail('This entry has already been undone or is an undo entry', 409);
      return send(res, 200, await applyRecords(malId, entry.changes.map(c => ({ episode: c.episode, expected: c.after, restore: c.before, source: 'undo' })), 'Undo', entry.id));
    }
    if (mode === 'prepare') {
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 6) throw fail('Preview batches must contain 1–6 episodes');
      const loaded = await loadDatabase(), anime = findAnime(loaded.database, malId)?.[1];
      const seen = new Set();
      for (const item of body.items) {
        if (!episodeNumber(item.episode) || seen.has(String(Number(item.episode)))) throw fail('Invalid or duplicate episode');
        seen.add(String(Number(item.episode)));
      }
      const rows = await Promise.all(body.items.map(async item => {
        const episode = Number(item.episode), previous = anime?.episodes?.[String(episode)] ?? null;
        try {
          const fetched = await fetchCrunchyroll(item.mediaId);
          const patch = { ...(fetched.op ? { op: fetched.op } : {}), ...(fetched.ed ? { ed: fetched.ed } : {}) };
          const after = mergeRecord(previous, patch);
          return { ...item, episode, expected: previous, patch, after, source: 'crunchyroll', sourceUpdatedAt: fetched.lastUpdated, status: same(previous, after) ? 'unchanged' : 'ready' };
        } catch (error) { return { ...item, episode, expected: previous, status: error.status === 404 ? 'no-data' : 'failed', error: error.message }; }
      }));
      return send(res, 200, { ok: true, rows });
    }
    if (mode === 'apply') {
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw fail('Select 1–200 records');
      const seen = new Set();
      const items = body.items.map(item => {
        const episode = episodeNumber(item.episode);
        if (!episode || seen.has(String(episode))) throw fail('Invalid or duplicate episode');
        seen.add(String(episode));
        if (!Object.hasOwn(item, 'expected')) throw fail('A preview is required for each record');
        const patch = {};
        for (const field of ['op', 'ed']) {
          if (item.patch?.[field] != null) patch[field] = range(item.patch[field], field);
          if (typeof item.patch?.[`${field}Absent`] === 'boolean') patch[`${field}Absent`] = item.patch[`${field}Absent`];
        }
        if (!Object.keys(patch).length) throw fail('Provide a range or an absence status');
        return { episode, expected: item.expected, patch, source: item.source, mediaId: item.mediaId };
      });
      return send(res, 200, await applyRecords(malId, items));
    }
    // Backward-compatible direct submissions are audited too. The new UI
    // always uses explicit preview/apply with optimistic concurrency.
    if (mode === 'bulk') throw fail('Use the new preview import to save bulk records');
    const episode = episodeNumber(body.episode);
    if (!episode) throw fail('A valid episode number is required');
    const loaded = await loadDatabase(), previous = findAnime(loaded.database, malId)?.[1]?.episodes?.[String(episode)] ?? null;
    let patch = { op: body.op, ed: body.ed, opAbsent: body.opAbsent, edAbsent: body.edAbsent };
    if (body.mediaId) { const fetched = await fetchCrunchyroll(body.mediaId); patch = { ...patch, op: patch.op || fetched.op, ed: patch.ed || fetched.ed }; }
    if (!patch.op && !patch.ed && !Object.hasOwn(body, 'opAbsent') && !Object.hasOwn(body, 'edAbsent')) throw fail('Provide a range or absence status');
    const result = await applyRecords(malId, [{ episode, expected: previous, patch, source: body.mediaId ? 'crunchyroll' : 'manual', mediaId: body.mediaId }]);
    return send(res, 200, { ...result, episode, record: result.records[0].record, complete: complete(result.records[0].record) });
  } catch (error) { return send(res, error.status || 500, { ok: false, error: error.message || 'Unexpected error' }); }
}
