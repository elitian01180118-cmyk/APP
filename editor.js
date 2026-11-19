'use strict';
/* Rich-text Note: several sections (Mental Notes, Technical Notes, Notes, Parenting, Self Growth), stored in IndexedDB (not localStorage), with backup / restore.
   Uses a contenteditable surface; no external libraries, works offline. */

// ---------- which app / which sections ----------
// APP and APP2 run this exact same file; the address (/APP/ or /APP2/) picks the storage keys, so the two apps keep separate notes.
const APP_ID = /\/APP2(\/|$)/i.test(location.pathname) ? 'app2' : 'app';
const SECTIONS = [
  { name: 'Mental Notes', key: `note:${APP_ID}:mental` },
  { name: 'Technical Notes', key: `note:${APP_ID}:technical` },
  { name: 'Notes', key: APP_ID === 'app2' ? 'note' : 'note:app' },   // the original single note keeps its old key
  { name: 'Parenting, my beloved half, family', key: `note:${APP_ID}:parenting`, aliases: ['Parenting'] },   // aliases: older backup files used this name
  { name: 'Self Growth', key: `note:${APP_ID}:selfgrowth` },
];   // new areas go at the END: the remembered position (an index) of the existing ones stays valid

// ---------- IndexedDB ----------
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('gridnow-notes', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('notes');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction('notes', mode), s = t.objectStore('notes'), q = fn(s);
    t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)) };
})();

// ---------- sanitizer (used for paste, stored HTML and restored backups) ----------
const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG', 'DIV', 'BLOCKQUOTE']);
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const walk = (node, out) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) { out.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'HEAD', 'TITLE'].includes(tag)) continue;
      if (!ALLOWED.has(tag)) { walk(n, out); continue; }               // unknown tag: keep its text, drop the tag
      if (tag === 'IMG') {
        const src = n.getAttribute('src') || '';
        if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) { const i = document.createElement('img'); i.src = src; out.appendChild(i); }
        continue;
      }
      const el = document.createElement(tag.toLowerCase());
      if ((tag === 'TD' || tag === 'TH')) { for (const a of ['colspan', 'rowspan']) { const v = parseInt(n.getAttribute(a), 10); if (v > 1 && v < 50) el.setAttribute(a, v); } }
      walk(n, el); out.appendChild(el);
    }
  };
  const box = document.createElement('div'); walk(doc.body, box); return box.innerHTML;
}
const say = m => { $('notestatus').textContent = m; };
const plainToHtml = t => t.split(/\n/).map(l => l ? `<p>${esc(l)}</p>` : '<p><br></p>').join('');

// ---------- state ----------
const ed = document.getElementById('note');            // the contenteditable surface
let noteIdx = store.get(`note:${APP_ID}:section`, 2);
if (!Number.isInteger(noteIdx) || noteIdx < 0 || noteIdx >= SECTIONS.length) noteIdx = 2;
let loaded = false, saveTimer = null, lastRange = null, lastSaved = null;

async function readSection(i) {
  const key = SECTIONS[i].key;
  let html = null;
  try { html = await idb.get(key); } catch {}
  if (typeof html === 'string') return sanitize(html);
  const legacy = store.get(key, '');                       // plain-text note from before the editor existed (kept untouched as a backup)
  return typeof legacy === 'string' && legacy ? plainToHtml(legacy) : '';
}
async function writeSection(i, html) { try { await idb.set(SECTIONS[i].key, html); } catch (e) { alert('Could not save note: ' + e.message); } }

function refreshEmpty() { ed.classList.toggle('empty', !ed.textContent.trim() && !ed.querySelector('img,table')); }
async function showNote() {
  loaded = false;
  $('note-title').textContent = SECTIONS[noteIdx].name;
  ed.innerHTML = (await readSection(noteIdx)) || '<div><br></div>';
  lastSaved = ed.innerHTML;
  loaded = true; refreshEmpty(); ed.scrollTop = 0; updateToolbar();
}
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!loaded || ed.innerHTML === lastSaved) return;                       // nothing changed: do not rewrite
  lastSaved = ed.innerHTML; return writeSection(noteIdx, lastSaved);
}
function saveSoon() { refreshEmpty(); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }

// The toolbar is only there while you are editing: tapping the note (including the blank space below the text) shows it,
// "Done" or tapping anything outside the note hides it. Pressing a toolbar button never takes the focus away from the note.
const showTools = on => { $('tools').classList.toggle('off', !on); updateToolbar(); };
ed.addEventListener('focus', () => showTools(true));
ed.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ed) { showTools(false); saveNow(); } }, 0));
ed.addEventListener('input', saveSoon);
ed.addEventListener('keyup', () => updateToolbar());
ed.addEventListener('click', ev => {
  if (ev.target !== ed || document.activeElement === ed) return;            // a tap on empty space inside the note (not on a line of text)
  ed.focus();
  const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
});
let caretRaf = 0;
function keepCaretVisible() {
  caretRaf = 0;
  if (document.activeElement !== ed) return;
  const s = getSelection(); if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  let rect = r.getClientRects()[0];
  if (!rect || (!rect.width && !rect.height)) { const n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement; rect = n && n.getBoundingClientRect(); }
  if (!rect) return;
  const vh = window.visualViewport ? visualViewport.height : innerHeight;
  const bottom = vh - $('tools').offsetHeight - 14, top = 72;                // keep clear of the tools below and the clock above
  if (rect.bottom > bottom) scrollBy(0, rect.bottom - bottom);
  else if (rect.top < top && scrollY > 0) scrollBy(0, rect.top - top);
}
const caretSoon = () => { if (!caretRaf) caretRaf = requestAnimationFrame(keepCaretVisible); };
ed.addEventListener('input', caretSoon);
document.addEventListener('selectionchange', () => { if (document.activeElement === ed) caretSoon(); });
ed.addEventListener('click', () => updateToolbar());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
addEventListener('pagehide', saveNow);
$('note-title').addEventListener('click', async () => {
  await saveNow();
  noteIdx = (noteIdx + 1) % SECTIONS.length;
  store.set(`note:${APP_ID}:section`, noteIdx);
  showNote();
});

// ---------- paste: keep structure, drop everything risky ----------
ed.addEventListener('paste', async e => {
  const cd = e.clipboardData; if (!cd) return;
  const img = [...cd.files].find(f => f.type.startsWith('image/'));
  e.preventDefault();
  if (img) { insertImage(img); return; }
  const html = cd.getData('text/html');
  if (html) document.execCommand('insertHTML', false, sanitize(html));
  else document.execCommand('insertText', false, cd.getData('text/plain'));
});

// ---------- toolbar ----------
try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch {}
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (s.rangeCount && ed.contains(s.anchorNode)) { lastRange = s.getRangeAt(0).cloneRange(); updateToolbar(); }
});
function restoreSelection() {
  const s = getSelection();
  if (document.activeElement === ed && s.rangeCount && ed.contains(s.anchorNode)) return;   // caret is still live: do not overwrite it
  ed.focus();                                                                                // focus was lost (e.g. the photo picker): go back
  if (lastRange) { s.removeAllRanges(); s.addRange(lastRange); }
}
const cellOf = () => { const s = getSelection(); let n = s.anchorNode; while (n && n !== ed) { if (n.nodeType === 1 && (n.tagName === 'TD' || n.tagName === 'TH')) return n; n = n.parentNode; } return null; };
const blockOf = () => { const v = (document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, ''); return v; };

function updateToolbar() {
  const on = (id, v) => { const b = document.getElementById(id); if (b) b.classList.toggle('on', !!v); };
  try {
    on('tb-bold', document.queryCommandState('bold')); on('tb-italic', document.queryCommandState('italic')); on('tb-underline', document.queryCommandState('underline'));
    on('tb-ul', document.queryCommandState('insertUnorderedList')); on('tb-ol', document.queryCommandState('insertOrderedList'));
    const b = blockOf(); on('tb-h1', b === 'h1'); on('tb-h2', b === 'h2');
  } catch {}
  $('tabletools').hidden = !(document.activeElement === ed && cellOf());
}

const BLOCK = /^(P|DIV|H1|H2|H3|LI|TD|TH|BLOCKQUOTE)$/;
const blockAt = n => { while (n && n !== ed) { if (n.nodeType === 1 && BLOCK.test(n.tagName)) return n; n = n.parentNode; } return ed; };
function caretOffset() {
  const s = getSelection(); if (!s.rangeCount || !s.isCollapsed || !ed.contains(s.anchorNode)) return null;
  const r = s.getRangeAt(0), pre = document.createRange(); pre.selectNodeContents(blockAt(r.startContainer)); pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaretOffset(off) {
  const s = getSelection(); if (!s.rangeCount || !ed.contains(s.anchorNode)) return;
  const blk = blockAt(s.anchorNode), w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT); let left = off, t;
  while ((t = w.nextNode())) { if (left <= t.length) { s.collapse(t, left); return; } left -= t.length; }
  s.collapse(blk, blk.childNodes.length);
}

function insertImage(file) {
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const max = 1600, r = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    restoreSelection();
    document.execCommand('insertHTML', false, `<img src="${c.toDataURL('image/jpeg', 0.85)}"><p><br></p>`);
    saveSoon();
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('Could not read that image'); };
  img.src = url;
}

function insertTable() {
  restoreSelection();
  const row = '<tr><td><br></td><td><br></td><td><br></td></tr>';
  document.execCommand('insertHTML', false, `<table><tbody>${row}${row}${row}</tbody></table><p><br></p>`);
  saveSoon();
}
function tableOp(op) {
  restoreSelection();
  const cell = cellOf(); if (!cell) return;
  const tr = cell.parentElement, table = cell.closest('table'), idx = cell.cellIndex;
  if (op === 'row+') { const n = tr.cloneNode(true); n.querySelectorAll('td,th').forEach(c => c.innerHTML = '<br>'); tr.after(n); }
  if (op === 'col+') table.querySelectorAll('tr').forEach(r => { const c = document.createElement(r.cells[idx].tagName.toLowerCase()); c.innerHTML = '<br>'; r.cells[idx].after(c); });
  if (op === 'row-') { if (table.rows.length > 1) tr.remove(); else table.remove(); }
  if (op === 'col-') { if (tr.cells.length > 1) table.querySelectorAll('tr').forEach(r => r.cells[idx] && r.cells[idx].remove()); else table.remove(); }
  if (op === 'table-') table.remove();
  refreshEmpty(); saveSoon(); updateToolbar();
}

const ACTIONS = {
  bold: () => document.execCommand('bold'), italic: () => document.execCommand('italic'), underline: () => document.execCommand('underline'),
  h1: () => document.execCommand('formatBlock', false, blockOf() === 'h1' ? 'p' : 'h1'),
  h2: () => document.execCommand('formatBlock', false, blockOf() === 'h2' ? 'p' : 'h2'),
  ul: () => document.execCommand('insertUnorderedList'), ol: () => document.execCommand('insertOrderedList'),
  undo: () => document.execCommand('undo'), redo: () => document.execCommand('redo'),
  table: insertTable, image: () => { restoreSelection(); $('noteimg').click(); },
};
document.querySelectorAll('#toolbar [data-act], #tabletools [data-op]').forEach(b => {
  // keep the keyboard and the caret where they are while a toolbar button is pressed
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', () => {
    if (b.dataset.op) return tableOp(b.dataset.op);
    if (b.dataset.act === 'done') { ed.blur(); return; }
    restoreSelection();
    // Block commands (lists, headings) can throw the caret to the start of the line in some browsers:
    // remember "which character of the line" it was on and put it back afterwards.
    const keep = ['h1', 'h2', 'ul', 'ol'].includes(b.dataset.act) ? caretOffset() : null;
    ACTIONS[b.dataset.act]();
    if (keep !== null) setCaretOffset(keep);
    saveSoon(); updateToolbar();
  });
});
$('noteimg').addEventListener('change', e => { const f = e.target.files[0]; if (f) insertImage(f); e.target.value = ''; });

// ---------- backup / restore (all of this app's note sections) ----------
async function exportNotes() {
  await saveNow();
  const notes = {};
  for (let i = 0; i < SECTIONS.length; i++) notes[SECTIONS[i].name] = await readSection(i);
  const blob = new Blob([JSON.stringify({ app: 'GridNow', version: 1, exportedAt: new Date().toISOString(), notes })], { type: 'application/json' });
  const a = document.createElement('a'), d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `gridnow-notes-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  say(`Exported ${(blob.size / 1024).toFixed(0)} KB`);
}
async function restoreNotes(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'GridNow' || typeof data.notes !== 'object') throw new Error('Not a GridNow backup file');
    const found = SECTIONS.map((s, i) => [i, [s.name, ...(s.aliases || [])].find(n => typeof data.notes[n] === 'string')]).filter(([, n]) => n);
    if (!found.length) throw new Error('No notes found in this file');
    if (!confirm(`Replace these notes with the backup?\n${found.map(([i]) => SECTIONS[i].name).join(', ')}`)) return;
    for (const [i, n] of found) await writeSection(i, sanitize(data.notes[n]));
    await showNote(); say(`Restored ${found.length} note area(s)`);
  } catch (e) { say('Restore failed: ' + e.message); }
}
$('export-notes').addEventListener('click', exportNotes);
$('restore-notes').addEventListener('click', () => $('restore-file').click());
$('restore-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) restoreNotes(f); e.target.value = ''; });

showNote();
