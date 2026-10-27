# Clixarena Skip Studio

A Vercel timestamp editor backed by a GitHub JSON database. This version retains the supplied database and public JSON publishing workflow and adds preview, resumable import, explicit absence flags, title search, video timing tools, and audited undo.

## Set up

1. Upload this project to the source GitHub repository connected to your existing Vercel project.
2. Retain your existing `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_DATA_PATH`, and `ADMIN_KEY` environment variables. `.env.example` shows placeholder values only.
3. The optional new variable `GITHUB_HISTORY_PATH` defaults to `data/editor-history.json`. This path must differ from the database path. The history file is created automatically on the first changed save; do not manually reset it.
4. Redeploy the Vercel project. The configuration explicitly serves `public/` and retains `/api/record` and `/api/editor` as serverless endpoints. See [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json).
5. Enter your admin password in the editor. It is sent in the request header and never saved in the import checkpoint.

The GitHub token needs Contents read/write access to the source repository. For automatic public publishing, retain the existing `PUBLIC_DATA_TOKEN` Actions secret with Contents read/write access to `clix-owner/Resources-Clix`. The supplied workflow continues publishing only `data/aniskip_data.json` to `aniskip_data.json` in that repository. History remains in the source repository.

## Episode editing

- Search by title within the database. Check **Include AniList titles** to also find titles not yet in the database. Select the result to populate its MAL ID.
- Load the missing/partial queue or enter an episode number and choose **Load record**.
- Enter seconds (`90.5`), minutes/seconds (`01:30.5`), or hours/minutes/seconds (`1:02:03`). Invalid, partial, negative, null, and empty ranges are not accepted as zero.
- Fetch optional Crunchyroll timestamps with a Media ID. Fetching never saves automatically.
- Mark **Opening/Ending is not present** only when you have verified that the segment does not exist. This is distinct from an unknown/missing range and removes the corresponding saved range when applied.
- Choose **Preview changes**, review before/after values, and **Save selected records**. A successful save refreshes the queue.

Not-present flags are additive fields in the existing record schema:

```json
{
  "opAbsent": true,
  "ed": { "start": 1200, "end": 1290 }
}
```

Existing OP/ED range shapes are unchanged. Restoring a range clears its absence flag. Unchecking a saved absence flag without entering a range makes that segment missing again. Older players reading only `op` and `ed` continue to use the same ranges; they can optionally use absence flags to distinguish deliberately absent segments.

## Bulk import and season mapping

1. Choose the **target MAL ID**. A separate season's MAL ID usually requires offset 0. A series database using absolute episode numbers requires a verified offset.
2. Enter the source start/end episode numbers. Imports accept 1–200 episodes at a time.
3. Set an optional season label and episode offset. For example, source Season 2 Episode 1 plus offset 51 writes database Episode 52. Mapping is explicit; it does not guess the correct franchise MAL ID.
4. Paste a Crunchyroll episode response and extract normal Media IDs, or paste ordered IDs yourself. The existing special/recap detection and original Japanese-version selection are retained.
5. **Fetch preview** fetches at most six episodes per request. The table shows mapping, IDs, old/new values, and `ready`, `unchanged`, `no-data`, `failed`, or `pending` status. Only changed records can be selected.
6. **Pause** stops after the in-flight batch. **Resume saved import** restores this device's checkpoint, fetching only pending/failed rows. **Retry failed only** fetches only temporary failures. A genuine 404 is `no-data`; a rate limit, timeout, invalid ID, or upstream error is not silently treated as missing timestamps.
7. Save any chosen changed rows together in one Git commit. Other records are not modified. An unchanged retry does not create another commit.

Checkpoints live in this browser's local storage; they are not shared across devices. Clearing browser storage removes the checkpoint. Passwords, GitHub tokens, and video files are not checkpointed. A checkpoint is saved after each completed batch, so an interrupted in-flight batch can be fetched again safely. One active draft is retained at a time; starting a new preview replaces it.

If another editor changes an episode after preview, saving returns a conflict rather than overwriting that edit. Load/re-preview that episode, or refetch the bulk preview. If a save response was lost after a successful commit, retrying the same preview is safe: already applied records are treated as unchanged.

## Video preview

Open a local video file or a direct HTTP(S) video URL. Local files stay on the device. The video must be playable by the browser; arbitrary streaming-site pages, DRM streams, and unsupported formats are not converted or proxied.

Use **Play start/end**, select a timestamp field, adjust by ±0.5 seconds, or copy the player's current time. Manual preview rejects ranges beyond the loaded video's known duration. Match the video's version to the source timestamps; different releases may contain offsets.

## History and undo

Every changed save writes the database and history in the same Git commit. Each history entry records its ID, time, MAL ID/title, changed episodes, source, Media ID, and before/after records. No migration fabricates history for the starting database.

The UI displays the latest 100 entries for the selected title; all entries remain stored in the history file. **Undo this change** restores only that entry's affected records, preserving unrelated records. Newly created episode records are removed when their creation is undone. A later edit to an affected record blocks the entire undo. Undo itself creates a new audited change. Repeated undo is rejected. The anime's identity and planned total are not removed when its first imported episodes are undone.

`totalEpisodes` remains the planned series count from the source metadata; importing a range does not inflate it to the end of a requested range. The missing queue considers both the planned total and the highest stored regular episode, with a 5000-episode limit per request.

## APIs

- `GET /api/record`: original episode lookup, missing queue, and Crunchyroll timestamp lookup.
- `GET /api/editor?mode=search&q=...&remote=1`: title search.
- `GET /api/editor?mode=history&malId=...`: history.
- `POST /api/editor` with `mode: prepare`: preview 1–6 mapped episodes without writing.
- `POST /api/editor` with `mode: apply`: selected validated patches with their `expected` previous records.
- `POST /api/editor` with `mode: undo`: MAL ID and history entry ID.

All editor endpoints require `X-Admin-Key`. Legacy direct POSTs to `/api/record` are routed through the same audited writer. The old one-request bulk POST is retired in favor of preview/apply so long imports can resume and retry correctly.

## Validation

Use Node 24+ and run `npm run check`. Tests require no installed application dependencies and do not contact live services or repositories. They cover syntax/element references, existing special extraction, null-range rejection, upstream status classification, preview mapping, audit/data atomicity, selective saves, replay, concurrency conflicts, undo protection, title creation/search, absence flags, queue completion, UI resume/retry/pause, and player timestamp precision.

Live Vercel deployment, real GitHub permissions, live AniList/Crunchyroll responses, public publishing, and actual media playback still require verification with your configured environment.
