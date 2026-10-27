const $ = id => document.getElementById(id);
let queue = [], activeEpisode = null, bulkSpecials = [], rows = [], running = false, saving = false, paused = false, importMalId = null, objectUrl = null, loadedEpisode = null;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status = (message, ok = false) => { for (const id of ['status','globalStatus']) { $(id).textContent = message; $(id).className = `status ${ok ? 'ok' : 'error'}`; } };
const bulkStatus = (message, ok = false) => { $('bulkStatus').textContent = message; $('bulkStatus').className = `status ${ok ? 'ok' : 'error'}`; };
const mal = () => { const id = Number($('malId').value); if (!Number.isInteger(id) || id < 1) throw Error('Choose a valid MAL ID'); return id; };
async function api(mode, body, query = {}) {
  const key = $('adminKey').value;
  if (!key) throw Error('Enter the admin password first');
  const response = await fetch(body ? '/api/editor' : '/api/editor?' + new URLSearchParams({ mode, ...query }), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key }, ...(body ? { body: JSON.stringify({ mode, ...body }) } : {}) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || 'Request failed'); return data;
}
async function lookup(episode, id = mal()) {
  const response = await fetch('/api/record?' + new URLSearchParams({ malId: id, episode }));
  const data = await response.json(); if (!response.ok) throw Error(data.error); return data.record;
}
function seconds(text) {
  if (String(text).trim() === '') return null;
  if (!/^\d+(?:\.\d+)?$|^\d+:\d{1,2}(?:\.\d+)?$|^\d+:\d{1,2}:\d{1,2}(?:\.\d+)?$/.test(String(text).trim())) throw Error('Enter seconds, mm:ss, or hh:mm:ss');
  const parts = String(text).split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some(n => n >= 60)) throw Error('Minutes/seconds components must be below 60');
  return parts.reduce((n, part) => n * 60 + part, 0);
}
function manualPatch() {
  const patch = {};
  for (const field of ['op','ed']) {
    if ($(field+'Absent').checked) { patch[field+'Absent'] = true; continue; }
    if (loadedEpisode?.record?.[field+'Absent']) patch[field+'Absent'] = false;
    const start = seconds($(field+'Start').value), end = seconds($(field+'End').value);
    if (start === null && end === null) continue;
    if (start === null || end === null || end <= start) throw Error(`${field.toUpperCase()}: end must be after start`);
    if (Number.isFinite($('video').duration) && end > $('video').duration) throw Error(`${field.toUpperCase()} exceeds the loaded video duration`);
    patch[field] = { start, end };
  }
  if (!Object.keys(patch).length) throw Error('Enter timestamps or mark OP/ED as not present');
  return patch;
}
function displayRecord(r) { if (!r) return 'No record'; return ['op','ed'].map(f => `${f.toUpperCase()}: ${r[f] ? `${r[f].start}–${r[f].end}s` : r[f+'Absent'] ? 'Not present' : 'Missing'}`).join(' · '); }
function merge(previous, patch) { const r = {...previous}; for(const f of ['op','ed']) { if(patch[f+'Absent']){delete r[f];r[f+'Absent']=true;}else if(patch[f]){r[f]=patch[f];delete r[f+'Absent'];}else if(patch[f+'Absent']===false)delete r[f+'Absent']; }return r; }
function saveDraft() { try { localStorage.setItem('skip-studio-import', JSON.stringify({ version:1, malId:importMalId, rows, season:$('seasonLabel').value, offset:$('episodeOffset').value })); } catch { bulkStatus('Draft storage is unavailable. Keep this tab open to preserve progress.'); } }
function renderPreview() {
  $('previewPanel').hidden = !rows.length;
  $('previewContext').textContent = `MAL ${importMalId} · ${rows.length} records · only selected changes will be saved.${bulkSpecials.length ? ' Specials excluded: '+bulkSpecials.map(x=>x.title||x.episode).join(', ')+'.' : ''}`;
  $('previewRows').innerHTML = rows.map((r,i) => `<tr><td><input type="checkbox" aria-label="Save episode ${r.episode}" data-select="${i}" ${r.selected?'checked':''} ${r.status!=='ready'?'disabled':''}></td><td>${escapeHtml(r.label || `Episode ${r.sourceEpisode ?? r.episode}`)} → ${r.episode}<small>${escapeHtml(r.mediaId || 'Manual edit')}</small></td><td>${escapeHtml(displayRecord(r.expected))}</td><td>${escapeHtml(displayRecord(r.after))}</td><td>${escapeHtml(r.status)}<small>${escapeHtml(r.error || '')}</small></td></tr>`).join('');
  $('progress').max = rows.length || 1; $('progress').value = rows.filter(r => r.status !== 'pending').length;
  $('previewRows').querySelectorAll('[data-select]').forEach(el => el.onchange = () => { rows[Number(el.dataset.select)].selected = el.checked; saveDraft(); });
}
function renderQueue() {
  $('summary').textContent = queue.length ? `${queue.length} missing or partial records` : 'Queue complete.';
  $('episodeList').innerHTML = queue.map(r => `<button class="episode-item ${r.episode===activeEpisode?'active':''}" data-episode="${r.episode}">Episode ${r.episode}<span>Missing ${r.missing.join(' / ').toUpperCase()}</span></button>`).join('') || '<p>No missing records.</p>';
  $('episodeList').querySelectorAll('button').forEach(b => b.onclick = () => selectEpisode(Number(b.dataset.episode)));
}
function fillRecord(r) { for (const f of ['op','ed']) { $(f+'Start').value = r?.[f]?.start ?? ''; $(f+'End').value = r?.[f]?.end ?? ''; $(f+'Absent').checked = Boolean(r?.[f+'Absent']); syncAbsent(f); } }
function syncAbsent(f) { $(f+'Start').disabled = $(f+'End').disabled = $(f+'Absent').checked; }
function selectEpisode(number) { activeEpisode=number; loadedEpisode={malId:mal(),episode:number,record:queue.find(r=>r.episode===number)?.record??null}; $('episode').value=number; $('selected').textContent=`Episode ${number}`; $('mediaId').value=''; fillRecord(loadedEpisode.record); renderQueue(); }
async function loadQueue() { try { const response=await fetch('/api/record?'+new URLSearchParams({mode:'missing',malId:mal(),...($('through').value?{through:$('through').value}:{})}));const data=await response.json();if(!response.ok)throw Error(data.error);queue=data.items;$('animeTitle').textContent=data.anime;renderQueue();if(queue.length)selectEpisode(queue[0].episode); }catch(e){status(e.message);} }
function showTab(name){ document.querySelectorAll('.tab').forEach(el=>el.hidden=el.id!==name);document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name)); }
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$('load').onclick=loadQueue;
$('searchTitle').onclick=async()=>{try{const data=await api('search',null,{q:$('titleQuery').value,remote:$('remoteSearch').checked?'1':'0'});$('searchResults').innerHTML=data.results.map((r,i)=>`<button data-result="${i}">${escapeHtml(r.title)} · MAL ${r.malId}${r.stored?'':' · new'}</button>`).join('')||'<p>No titles found.</p>';$('searchResults').querySelectorAll('button').forEach(b=>b.onclick=()=>{const r=data.results[Number(b.dataset.result)];$('malId').value=r.malId;$('animeTitle').textContent=r.title;loadedEpisode=null;queue=[];fillRecord(null);renderQueue();});}catch(e){status(e.message);}};
$('checkExisting').onclick=async()=>{try{const episode=Number($('episode').value);const record=await lookup(episode);loadedEpisode={malId:mal(),episode,record};fillRecord(record);status('Existing record loaded.',true);}catch(e){status(e.message);}};
$('fetchCrunchyroll').onclick=async()=>{try{const response=await fetch('/api/record?'+new URLSearchParams({mode:'crunchyroll',mediaId:$('mediaId').value}));const data=await response.json();if(!response.ok)throw Error(data.error);for(const f of ['op','ed'])if(data[f]){$(f+'Start').value=data[f].start;$(f+'End').value=data[f].end;$(f+'Absent').checked=false;syncAbsent(f);}status('Timestamps loaded. Review before saving.',true);}catch(e){status(e.message);}};
for(const f of ['op','ed'])$(f+'Absent').onchange=()=>syncAbsent(f);
$('previewManual').onclick=async()=>{try{if(running||saving)throw Error('Wait for the current operation first');const id=mal(),episode=Number($('episode').value);if(!Number.isFinite(episode)||episode<=0)throw Error('Enter an episode number');const patch=manualPatch();const expected=loadedEpisode?.malId===id&&loadedEpisode?.episode===episode?loadedEpisode.record:await lookup(episode,id);const after=merge(expected,patch);rows=[{episode,expected,patch,after,status:JSON.stringify(expected)===JSON.stringify(after)?'unchanged':'ready',selected:true,source:$('mediaId').value?'manual/crunchyroll':'manual',mediaId:$('mediaId').value||null}];importMalId=id;renderPreview();saveDraft();status('Review the before and after values below.',true);}catch(e){status(e.message);}};
async function runPreview(onlyFailed=false) {
  if(running||saving)return;running=true;paused=false;
  try { const candidates=rows.map((r,i)=>({r,i})).filter(({r})=>onlyFailed?r.status==='failed':r.status==='pending'||r.status==='failed');
    for(let offset=0;offset<candidates.length&&!paused;offset+=6){const chunk=candidates.slice(offset,offset+6);bulkStatus(`Fetching preview: ${offset+1}–${Math.min(offset+6,candidates.length)} of ${candidates.length}`,true);try{const data=await api('prepare',{malId:importMalId,items:chunk.map(({r})=>({episode:r.episode,mediaId:r.mediaId}))});data.rows.forEach((result,i)=>{const old=rows[chunk[i].i];rows[chunk[i].i]={...old,error:null,...result,selected:result.status==='ready'};});}catch(e){chunk.forEach(({i})=>rows[i]={...rows[i],status:'failed',selected:false,error:e.message});paused=true;}saveDraft();renderPreview();}
    const failed=rows.filter(r=>r.status==='failed').length;bulkStatus(`${paused?'Paused':'Preview finished'}. ${rows.filter(r=>r.status==='ready').length} changed, ${failed} failed, ${rows.filter(r=>r.status==='no-data').length} without timestamps.`,true);
  }finally{running=false;}
}
$('bulkPreview').onclick=async()=>{try{if(running||saving)return;const start=Number($('bulkStart').value),end=Number($('bulkEnd').value),offset=Number($('episodeOffset').value);const ids=$('bulkMediaIds').value.split(/[\s,]+/).filter(Boolean);if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end-start>=200||!Number.isInteger(offset)||start+offset<1||ids.length!==end-start+1)throw Error('Choose 1–200 episodes, a valid offset, and exactly one Media ID per episode');importMalId=mal();rows=ids.map((mediaId,i)=>({episode:start+i+offset,sourceEpisode:start+i,mediaId,label:`${$('seasonLabel').value||'Source'} E${start+i}`,status:'pending',selected:false}));renderPreview();saveDraft();await runPreview();}catch(e){bulkStatus(e.message);}};
$('pause').onclick=()=>{paused=true;bulkStatus('Pausing after the current batch. Progress is saved on this device.',true);};
$('resume').onclick=async()=>{try{if(running||saving)return;const draft=JSON.parse(localStorage.getItem('skip-studio-import')||'null');if(!draft||draft.version!==1)throw Error('No saved import found');rows=draft.rows;bulkSpecials=draft.specials||[];importMalId=draft.malId;$('malId').value=importMalId;$('seasonLabel').value=draft.season||'';$('episodeOffset').value=draft.offset||0;renderPreview();await runPreview();}catch(e){bulkStatus(e.message);}};
$('retry').onclick=()=>runPreview(true);
$('reset').onclick=()=>{if(saving)return;if(running){paused=true;bulkStatus('Wait for the current batch to finish before clearing.');return;}rows=[];localStorage.removeItem('skip-studio-import');renderPreview();};
$('selectChanged').onclick=()=>{rows.forEach(r=>r.selected=r.status==='ready');renderPreview();saveDraft();};
$('saveSelected').onclick=async()=>{if(running||saving)return;$('saveSelected').disabled=true;try{if(mal()!==importMalId)throw Error('The selected MAL ID differs from this preview');const selected=rows.filter(r=>r.selected&&r.status==='ready');if(!selected.length)throw Error('Select changed records first');const data=await api('apply',{malId:importMalId,items:selected.map(({episode,expected,patch,source,mediaId})=>({episode,expected,patch,source,mediaId}))});selected.forEach(r=>{r.status='saved';r.selected=false;});saveDraft();renderPreview();loadedEpisode=null;$('saveStatus').textContent=`Saved ${data.count} changes${data.commit?' · commit '+data.commit.slice(0,8):' · already applied'}.`;if(!$('manual').hidden)await loadQueue();}catch(e){$('saveStatus').textContent=e.message+' The preview is retained; retry if the connection failed, or re-fetch if records changed.';}finally{$('saveSelected').disabled=false;}};
async function loadHistory(){try{showTab('history');const data=await api('history',null,{malId:mal()});const undone=new Set(data.entries.filter(e=>e.undoOf).map(e=>e.undoOf));$('historyList').innerHTML=data.entries.map(e=>`<article class="history-entry"><strong>${escapeHtml(e.action)} · ${escapeHtml(e.title)}</strong><p>${escapeHtml(new Date(e.at).toLocaleString())} · ${e.changes.length} records · ${escapeHtml(e.id)}</p><details><summary>View changes</summary>${e.changes.map(c=>`<p class="record-line">Episode ${c.episode} · ${escapeHtml(c.source)} ${escapeHtml(c.mediaId||'')}<br>Before: ${escapeHtml(displayRecord(c.before))}<br>After: ${escapeHtml(displayRecord(c.after))}</p>`).join('')}</details>${e.undoOf||undone.has(e.id)?'<span>Undo entry / already undone</span>':`<button data-undo="${escapeHtml(e.id)}">Undo this change</button>`}</article>`).join('')||'<p>No changes recorded by Skip Studio yet.</p>';$('historyList').querySelectorAll('[data-undo]').forEach(b=>b.onclick=async()=>{if(!confirm('Restore the previous values for this change? Newer edits will be protected.'))return;b.disabled=true;try{await api('undo',{malId:mal(),historyId:b.dataset.undo});await loadHistory();}catch(e){status(e.message);b.disabled=false;}});}catch(e){$('historyList').textContent=e.message;}}
$('loadHistory').onclick=loadHistory;
function loadVideo(url){$('video').src=url;$('videoStatus').textContent='Video loaded. Use the timestamp fields to inspect boundaries.';}
$('videoFile').onchange=()=>{const file=$('videoFile').files[0];if(!file)return;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(file);loadVideo(objectUrl);};
$('openVideo').onclick=()=>{try{const url=new URL($('videoUrl').value);if(!['https:','http:'].includes(url.protocol))throw Error('Use an HTTP or HTTPS video URL');loadVideo(url.href);}catch(e){$('videoStatus').textContent=e.message;}};
$('video').onerror=()=>{$('videoStatus').textContent='This video could not be opened. Try a local file or a browser-compatible direct video URL.';};
document.querySelectorAll('[data-seek]').forEach(b=>b.onclick=async()=>{try{const time=seconds($(b.dataset.seek).value);if(time===null||!Number.isFinite($('video').duration))throw Error('Load a video and enter a timestamp first');if(time>$('video').duration)throw Error('Timestamp exceeds video duration');$('video').currentTime=time;await $('video').play();}catch(e){$('videoStatus').textContent=e.message;}});
function adjust(delta){try{const field=$('adjustField').value;$(field).value=Math.round(Math.max(0,(seconds($(field).value)||0)+delta)*1000)/1000;}catch(e){$('videoStatus').textContent=e.message;}}
$('minus').onclick=()=>adjust(-.5);$('plus').onclick=()=>adjust(.5);$('useTime').onclick=()=>{if(!Number.isFinite($('video').duration))return;$($('adjustField').value).value=Math.round($('video').currentTime*1000)/1000;};
