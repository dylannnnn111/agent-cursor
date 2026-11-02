// Agent Cursor sidebar panel. Plain JS, no libraries.
(function () {
  const vscode = acquireVsCodeApi();
  const PALETTE = ['#E0533F', '#4C7BD9', '#1FA392', '#D9971E', '#9A6BE0'];
  const ROW = 22;
  const BIG_TREE = 400;
  const VERB = {
    reading: 'reading',
    editing: 'editing',
    writing: 'writing',
    searching: 'searching',
    running: 'running',
    browsing: 'web',
    delegating: 'handing off',
    working: 'working',
    thinking: 'thinking',
    idle: 'idle',
  };

  const saved = vscode.getState() || {};
  let roots = [];
  let files = [];
  let truncated = false;
  let state = { agents: [], touched: [], feed: [], follow: false, connected: true, now: Date.now() };
  let collapsed = new Set(saved.collapsed || []);
  let showAll = saved.showAll; // undefined = decide by size
  let rows = [];
  let rowIndex = new Map();
  let treeKey = '';
  let lastUserScroll = 0;
  const lastFile = new Map();

  const app = document.getElementById('app');
  app.innerHTML = `
    <section class="agents">
      <div class="head">
        <h2>Agents</h2>
        <label class="follow" title="Open each file the agent moves to">
          <input type="checkbox" id="follow"><span class="track"><span class="knob"></span></span>Follow
        </label>
      </div>
      <div id="agents"></div>
    </section>
    <section class="files">
      <div class="head">
        <h2>Files</h2>
        <button id="scope" class="link" hidden></button>
      </div>
      <div id="tree" class="tree"><div id="rows"></div><div id="layer" class="layer"></div></div>
      <p id="filesNote" class="note" hidden></p>
    </section>
    <section class="feed">
      <div class="head"><h2>Activity</h2></div>
      <ol id="feed"></ol>
    </section>`;

  const $ = (id) => document.getElementById(id);
  const color = (i) => PALETTE[i % PALETTE.length];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function persist() {
    vscode.setState({ collapsed: [...collapsed], showAll });
  }

  $('follow').addEventListener('change', (e) => vscode.postMessage({ type: 'follow', on: e.target.checked }));
  $('scope').addEventListener('click', () => {
    showAll = !wantAll();
    persist();
    buildTree(true);
    placeAgents();
  });
  window.addEventListener('wheel', () => (lastUserScroll = Date.now()), { passive: true });
  window.addEventListener('touchmove', () => (lastUserScroll = Date.now()), { passive: true });

  // ---------- tree ----------

  function rootOf(file) {
    let best;
    for (const r of roots) {
      if ((file === r.path || file.startsWith(r.path + '/') || file.startsWith(r.path + '\\')) && (!best || r.path.length > best.path.length)) best = r;
    }
    return best;
  }

  function relParts(file) {
    const r = rootOf(file);
    if (!r) return null;
    const rel = file.slice(r.path.length + 1).split(/[\\/]/);
    return roots.length > 1 ? [r.name, ...rel] : rel;
  }

  function wantAll() {
    return showAll === undefined ? files.length <= BIG_TREE : showAll;
  }

  function visibleFiles() {
    const touched = state.touched.map((t) => t.file);
    const here = state.agents.map((a) => a.file).filter(Boolean);
    const set = new Set(wantAll() ? files : []);
    for (const f of touched) set.add(f);
    for (const f of here) set.add(f);
    return [...set].filter((f) => relParts(f)).sort();
  }

  function buildTree(force) {
    const list = visibleFiles();
    const key = list.join('\n') + '|' + [...collapsed].join(',');
    if (!force && key === treeKey) return;
    treeKey = key;

    const root = { dirs: new Map(), files: [] };
    for (const f of list) {
      const parts = relParts(f);
      let node = root;
      let dirPath = '';
      for (const p of parts.slice(0, -1)) {
        dirPath += '/' + p;
        if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [], path: dirPath });
        node = node.dirs.get(p);
      }
      node.files.push({ name: parts[parts.length - 1], file: f });
    }

    rows = [];
    const walk = (node, depth, hiddenBy) => {
      const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, d] of dirs) {
        const isCollapsed = collapsed.has(d.path);
        if (!hiddenBy) rows.push({ kind: 'dir', name, depth, path: d.path, collapsed: isCollapsed });
        const owner = hiddenBy || (isCollapsed ? d.path : null);
        walk(d, depth + 1, owner);
      }
      for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (hiddenBy) {
          rowIndex.set(f.file, rows.findIndex((r) => r.kind === 'dir' && r.path === hiddenBy));
          continue;
        }
        rows.push({ kind: 'file', name: f.name, depth, file: f.file });
      }
    };
    rowIndex = new Map();
    walk(root, 0, null);
    rows.forEach((r, i) => r.kind === 'file' && rowIndex.set(r.file, i));

    $('rows').innerHTML = rows
      .map((r, i) => {
        const pad = 8 + r.depth * 12;
        if (r.kind === 'dir') {
          return `<div class="row dir" data-dir="${esc(r.path)}" style="top:${i * ROW}px;padding-left:${pad}px">
            <span class="chev">${r.collapsed ? '▸' : '▾'}</span><span class="name">${esc(r.name)}</span></div>`;
        }
        const ext = (r.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
        return `<div class="row file" data-file="${esc(r.file)}" style="top:${i * ROW}px;padding-left:${pad + 14}px">
          <span class="ext ext-${esc(ext.toLowerCase())}"></span><span class="name">${esc(r.name)}</span><span class="mark"></span></div>`;
      })
      .join('');
    $('rows').style.height = `${rows.length * ROW}px`;
    $('tree').style.height = `${Math.max(rows.length, 1) * ROW}px`;

    const all = wantAll();
    const scope = $('scope');
    scope.hidden = files.length === 0;
    scope.textContent = all ? 'Show only touched' : `Show all ${files.length}${truncated ? '+' : ''} files`;
    const note = $('filesNote');
    note.hidden = rows.length > 0;
    note.textContent = all ? 'No files in this workspace.' : 'Files the agent reads or changes will show up here.';
    paintTouched();
  }

  $('rows').addEventListener('click', (e) => {
    const dir = e.target.closest('.row.dir');
    if (dir) {
      const p = dir.dataset.dir;
      collapsed.has(p) ? collapsed.delete(p) : collapsed.add(p);
      persist();
      buildTree(true);
      placeAgents();
      return;
    }
    const f = e.target.closest('.row.file');
    if (f) {
      const agent = state.agents.find((a) => a.file === f.dataset.file);
      vscode.postMessage({ type: 'open', file: f.dataset.file, line: agent ? agent.line : 0 });
    }
  });

  function paintTouched() {
    const byFile = new Map(state.touched.map((t) => [t.file, t]));
    for (const el of $('rows').querySelectorAll('.row.file')) {
      const t = byFile.get(el.dataset.file);
      el.classList.toggle('read', !!t && !t.edited);
      el.classList.toggle('edited', !!t && t.edited);
      el.style.setProperty('--c', t ? color(t.colorIndex) : 'transparent');
      el.querySelector('.mark').textContent = t ? (t.edited ? '✎' : '•') : '';
    }
  }

  // ---------- agents ----------

  function placeAgents() {
    const layer = $('layer');
    const seen = new Set();
    const perRow = new Map();
    const ordered = [...state.agents].sort((a, b) => Number(a.sub) - Number(b.sub));
    for (const a of ordered) {
      if (!a.file) continue;
      const idx = rowIndex.get(a.file);
      if (idx === undefined || idx < 0) continue;
      seen.add(a.key);
      const slot = perRow.get(idx) || 0;
      perRow.set(idx, slot + 1);

      let el = layer.querySelector(`[data-key="${CSS.escape(a.key)}"]`);
      const fresh = !el;
      if (fresh) {
        el = document.createElement('div');
        el.className = 'agent';
        el.dataset.key = a.key;
        el.innerHTML = `<div class="bar"></div><div class="bot"><span class="ring"></span><span class="core">✦</span></div><div class="verb"></div>`;
        layer.appendChild(el);
        el.style.top = `${idx * ROW}px`;
      }
      const c = color(a.colorIndex);
      el.style.setProperty('--c', c);
      el.style.setProperty('--slot', slot);
      el.classList.toggle('busy', a.activity !== 'idle');
      el.classList.toggle('sub', !!a.sub);
      el.querySelector('.verb').textContent = VERB[a.activity] || a.activity;
      el.title = `${a.label} · ${a.detail}`;

      const prevTop = parseFloat(el.style.top) || 0;
      const top = idx * ROW;
      if (!fresh && prevTop !== top) {
        // a quick streak along the path it travelled
        const trail = document.createElement('div');
        trail.className = 'trail';
        trail.style.setProperty('--c', c);
        trail.style.setProperty('--slot', slot);
        trail.style.top = `${Math.min(prevTop, top) + ROW / 2}px`;
        trail.style.height = `${Math.abs(top - prevTop)}px`;
        layer.prepend(trail);
        requestAnimationFrame(() => requestAnimationFrame(() => trail.classList.add('gone')));
        setTimeout(() => trail.remove(), 900);
      }
      el.style.top = `${top}px`;

      const row = $('rows').children[idx];
      if (row && lastFile.get(a.key) !== a.file) {
        row.classList.remove('arrive');
        void row.offsetWidth;
        row.style.setProperty('--arrive', c);
        row.classList.add('arrive');
      }
      lastFile.set(a.key, a.file);
    }
    for (const el of [...layer.querySelectorAll('.agent')]) if (!seen.has(el.dataset.key)) el.remove();

    // keep the main agent in view unless the person is scrolling
    const lead = ordered.find((a) => a.file && a.activity !== 'idle' && !a.sub);
    if (lead && Date.now() - lastUserScroll > 4000) {
      const idx = rowIndex.get(lead.file);
      const row = idx >= 0 ? $('rows').children[idx] : null;
      if (row) row.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  function renderAgents() {
    const box = $('agents');
    $('follow').checked = !!state.follow;
    if (!state.agents.length) {
      box.innerHTML = `<div class="empty">
        <div class="empty-bot"><span class="ring"></span><span class="core">✦</span></div>
        <p>${state.connected ? 'Waiting for Claude Code. Start a session in this folder and the agent shows up here.' : 'Claude Code isn’t connected yet.'}</p>
        <div class="actions">
          ${state.connected ? '' : '<button class="primary" data-act="connect">Connect Claude Code</button>'}
          <button class="${state.connected ? 'primary' : ''}" data-act="demo">Try the demo</button>
        </div></div>`;
      return;
    }
    const order = [...state.agents].sort((a, b) => (a.key < b.key ? -1 : 1)).sort((a, b) => {
      const pa = a.sub ? a.key.split(':')[0] : a.key;
      const pb = b.sub ? b.key.split(':')[0] : b.key;
      return pa === pb ? Number(a.sub) - Number(b.sub) : pa < pb ? -1 : 1;
    });
    box.innerHTML = order
      .map((a) => {
        const where = a.file ? `<button class="where" data-file="${esc(a.file)}" data-line="${a.line ?? 0}">${esc(a.file.split(/[\\/]/).pop())}${a.line !== undefined ? `:${a.line + 1}` : ''}</button>` : '';
        return `<div class="who ${a.sub ? 'sub' : ''} ${a.activity !== 'idle' ? 'busy' : ''}" style="--c:${color(a.colorIndex)}">
          <span class="dot"></span>
          <div class="txt"><div class="line1"><b>${esc(a.label)}</b><span class="pill">${esc(VERB[a.activity] || a.activity)}</span></div>
          <div class="line2">${esc(a.detail)} ${where}</div></div></div>`;
      })
      .join('');
  }

  app.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) vscode.postMessage({ type: act.dataset.act });
    const where = e.target.closest('[data-file]:not(.row)');
    if (where) vscode.postMessage({ type: 'open', file: where.dataset.file, line: Number(where.dataset.line) || 0 });
  });

  // ---------- feed ----------

  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'now';
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
  }

  function renderFeed() {
    const list = $('feed');
    if (!state.feed.length) {
      list.innerHTML = '<li class="quiet">Nothing yet.</li>';
      return;
    }
    list.innerHTML = state.feed
      .map(
        (f) => `<li style="--c:${color(f.colorIndex)}" ${f.file ? `data-file="${esc(f.file)}" data-line="${f.line ?? 0}"` : ''} class="${f.file ? 'link' : ''}">
          <span class="dot"></span><span class="what"><span class="by">${esc(f.label)}</span> ${esc(f.text)}</span><time>${ago(f.at)}</time></li>`,
      )
      .join('');
  }

  setInterval(() => {
    for (const el of document.querySelectorAll('#feed time')) {
      const li = el.closest('li');
      const i = [...li.parentNode.children].indexOf(li);
      if (state.feed[i]) el.textContent = ago(state.feed[i].at);
    }
  }, 5000);

  // ---------- messages ----------

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'files') {
      roots = msg.roots || [];
      files = msg.files || [];
      truncated = !!msg.truncated;
      buildTree(true);
      placeAgents();
    } else if (msg.type === 'state') {
      state = msg.state;
      buildTree(false);
      paintTouched();
      renderAgents();
      placeAgents();
      renderFeed();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
