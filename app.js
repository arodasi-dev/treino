/* ===================================================================
   Meu Treino — PWA pessoal de academia
   Dados salvos localmente no aparelho via IndexedDB (funciona offline).
   =================================================================== */

/* ---------- Banco de dados: API no homeserver (SQLite) ----------
   Mesma interface de antes (getAll/get/put/del/clear). Os dados ficam no seu
   servidor (pasta `servidor/`), alcançado pelo Tailscale.
   Funciona OFFLINE: cada coleção é guardada num cache local (IndexedDB) e as
   gravações entram numa fila que sobe sozinha quando o servidor volta. */
const DB = (() => {
  const CFG_KEY = 'treino.server';
  let cfg = {};
  try{ cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; }catch(e){}
  let live = false;           // o último contato com o servidor deu certo?
  let cache = {};             // { coleção: { id: doc } }
  let outbox = [];            // [{m:'PUT'|'DEL'|'CLR', col, id, doc}]
  let flushing = false, ready = null;
  const listeners = [];
  const notify = () => listeners.forEach(f => { try{ f(); }catch(e){} });

  /* --- IndexedDB mínimo (chave → valor) --- */
  const idb = () => new Promise((ok, fail) => {
    const r = indexedDB.open('treino-cache', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  async function kvGet(k){ const d = await idb(); return new Promise((ok, fail) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); }); }
  async function kvSet(k, v){ const d = await idb(); return new Promise((ok, fail) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => ok(); t.onerror = () => fail(t.error); }); }
  const persist = () => Promise.all([kvSet('cache', cache), kvSet('outbox', outbox)]).catch(e => console.error('cache local', e));
  function load(){
    if(!ready) ready = (async () => {
      try{ cache = (await kvGet('cache')) || {}; outbox = (await kvGet('outbox')) || []; }catch(e){ cache = {}; outbox = []; }
    })();
    return ready;
  }

  /* --- HTTP --- */
  async function api(method, path, body){
    if(!cfg.url || !cfg.token) throw Object.assign(new Error('sem servidor'), {fatal:true});
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
    try{
      const r = await fetch(cfg.url.replace(/\/+$/, '') + path, {
        method, signal: ctl.signal,
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      live = true;
      if(r.status === 404) return { notFound: true };
      if(!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
      return await r.json();
    }catch(e){
      if(!e.status) live = false;      // falha de rede / tempo esgotado
      throw e;
    }finally{ clearTimeout(t); notify(); }
  }

  /* --- fila de gravações --- */
  async function flush(){
    await load();
    if(flushing || !outbox.length || !cfg.url) return;
    flushing = true; notify();
    try{
      while(outbox.length){
        const op = outbox[0], base = '/api/c/' + encodeURIComponent(op.col);
        try{
          if(op.m === 'PUT') await api('PUT', base + '/' + encodeURIComponent(op.id), op.doc);
          else if(op.m === 'DEL') await api('DELETE', base + '/' + encodeURIComponent(op.id));
          else await api('DELETE', base);
        }catch(e){
          if(e.status && e.status !== 401 && e.status !== 429 && e.status < 500){ console.error('operação descartada', op, e); }
          else break;                   // sem rede / servidor fora / 401: tenta de novo depois
        }
        outbox.shift(); await persist();
      }
    }finally{ flushing = false; notify(); }
  }
  function enqueue(op){
    // junta gravações repetidas do mesmo documento (ex.: rascunho salvo a cada 600 ms)
    if(op.m === 'PUT'){
      const from = flushing ? 1 : 0;
      for(let i = outbox.length - 1; i >= from; i--) if(outbox[i].m === 'PUT' && outbox[i].col === op.col && outbox[i].id === op.id) outbox.splice(i, 1);
    }
    outbox.push(op);
  }
  const pending = (col) => outbox.filter(o => o.col === col);

  addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') flush(); });
  setInterval(flush, 20000);

  return {
    configured: () => !!(cfg.url && cfg.token),
    host: () => { try{ return new URL(cfg.url).host; }catch(e){ return cfg.url || ''; } },
    configure(url, token){ cfg = { url: String(url||'').trim().replace(/\/+$/, ''), token: String(token||'').trim() }; localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); },
    clearConfig(){ cfg = {}; localStorage.removeItem(CFG_KEY); live = false; notify(); },
    async test(){ await api('GET', '/api/c/meta'); },
    live: () => live,
    pendingCount: () => outbox.length,
    onChange(f){ listeners[0] = f; },
    flush,
    async getAll(s){
      await load();
      try{
        const list = await api('GET', '/api/c/' + encodeURIComponent(s));
        const map = {}; list.forEach(d => { map[d.id] = d; });
        for(const op of pending(s)){            // aplica por cima o que ainda não subiu
          if(op.m === 'PUT') map[op.id] = op.doc;
          else if(op.m === 'DEL') delete map[op.id];
          else for(const k in map) delete map[k];
        }
        cache[s] = map; persist();
      }catch(e){ if(e.fatal) throw e; }
      return Object.values(cache[s] || {});
    },
    async get(s, id){
      await load();
      if(!pending(s).some(o => o.id === id || o.m === 'CLR')){
        try{
          const d = await api('GET', '/api/c/' + encodeURIComponent(s) + '/' + encodeURIComponent(id));
          cache[s] = cache[s] || {};
          if(d.notFound) delete cache[s][id]; else cache[s][id] = d;
          persist();
        }catch(e){ if(e.fatal) throw e; }
      }
      return (cache[s] || {})[id];
    },
    async put(s, v){ await load(); cache[s] = cache[s] || {}; cache[s][v.id] = v; enqueue({ m:'PUT', col:s, id:v.id, doc:v }); await persist(); flush(); },
    async del(s, id){ await load(); if(cache[s]) delete cache[s][id]; enqueue({ m:'DEL', col:s, id }); await persist(); flush(); },
    async clear(s){ await load(); cache[s] = {}; outbox = outbox.filter(o => o.col !== s); enqueue({ m:'CLR', col:s }); await persist(); flush(); },
  };
})();

/* ---------- Estado em memória ---------- */
const state = { workouts:[], sessions:[], view:'workouts', detailId:null, session:null, draft:null, currentUser:null };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const $ = id => document.getElementById(id);

/* ---------- Helpers ---------- */
function toast(msg){
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove('show'), 1800);
}
function fmtDate(ts){
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'short'});
}
function dayKey(ts){ return new Date(ts).toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'}); }
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function mmss(sec){ const m=Math.floor(sec/60), s=sec%60; return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
function fmtDur(ms){ if(!ms||ms<0) return ''; const m=Math.round(ms/60000); if(m<1) return 'menos de 1 min'; if(m<60) return m+' min'; const h=Math.floor(m/60), mm=m%60; return h+'h'+(mm?(' '+String(mm).padStart(2,'0')+'min'):''); }
function hhmm(ts){ return new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }

/* ---------- Dados de exemplo (primeiro uso) ---------- */
function seed(){
  return [
    { id:uid(), name:'Treino A — Inferiores, Ombros e Costas + EMOM', order:0, exercises:[
      {id:uid(), name:'Agachamento livre (Back Squat)', sets:4, reps:'6-8', weight:0, rest:120, notes:'Aquecer 5min: mobilidade quadril e tornozelo'},
      {id:uid(), name:'Desenvolvimento Arnold (Arnold Press)', sets:4, reps:'8-10', weight:0, rest:120, notes:''},
      {id:uid(), name:'Remada curvada com barra', sets:4, reps:'8-10', weight:0, rest:120, notes:''},
      {id:uid(), name:'Kettlebell Swings', sets:4, reps:'15', weight:0, rest:0, notes:'EMOM 12min · minuto 1 · 4 ciclos'},
      {id:uid(), name:'Abdominais Borboleta (Sit-ups)', sets:4, reps:'15', weight:0, rest:0, notes:'EMOM · minuto 2'},
      {id:uid(), name:'Goblet Squats', sets:4, reps:'15', weight:0, rest:0, notes:'EMOM · minuto 3'},
    ]},
    { id:uid(), name:'Treino B — Cardio Leve + Core', order:1, exercises:[
      {id:uid(), name:'Bicicleta ergométrica', sets:1, reps:'40-45 min', weight:0, rest:0, notes:'Só bike · ritmo leve/passeio (sem suar muito)'},
      {id:uid(), name:'Prancha abdominal', sets:3, reps:'45-60 seg', weight:0, rest:45, notes:''},
      {id:uid(), name:'Russian Twist (anilha/halter)', sets:3, reps:'20', weight:0, rest:45, notes:''},
      {id:uid(), name:'Elevação de pernas suspensa', sets:3, reps:'12-15', weight:0, rest:45, notes:''},
    ]},
    { id:uid(), name:'Treino C — Inferiores, Costas e Ombros + AMRAP', order:2, exercises:[
      {id:uid(), name:'Levantamento terra (Deadlift)', sets:4, reps:'5-7', weight:0, rest:120, notes:'Aquecer 5min: mobilidade na bike'},
      {id:uid(), name:'Puxada alta (pulley) ou barra no Graviton', sets:4, reps:'8-10', weight:0, rest:120, notes:''},
      {id:uid(), name:'Elevação lateral com halteres', sets:4, reps:'10-12', weight:0, rest:120, notes:''},
      {id:uid(), name:'Dumbbell Snatches', sets:1, reps:'10 (5 cada braço)', weight:0, rest:0, notes:'AMRAP 10min · máx rounds'},
      {id:uid(), name:'Agachamento com salto (Jump Squats)', sets:1, reps:'15', weight:0, rest:0, notes:'AMRAP 10min'},
      {id:uid(), name:'Remada curvada com halteres', sets:1, reps:'10', weight:0, rest:0, notes:'AMRAP 10min'},
    ]},
    { id:uid(), name:'Treino D — Cardio Leve + Mobilidade', order:3, exercises:[
      {id:uid(), name:'Bicicleta ergométrica', sets:1, reps:'30 min', weight:0, rest:0, notes:'Só bike · ritmo leve/passeio'},
      {id:uid(), name:'Mobilidade', sets:1, reps:'15 min', weight:0, rest:0, notes:'Pernas, glúteos, isquiotibiais e lombar + rolo miofascial'},
    ]},
    { id:uid(), name:'Treino E — Inferiores, Costas e Ombros + WOD For Time', order:4, exercises:[
      {id:uid(), name:'Afundo com halteres ou Bulgarian Split Squat', sets:4, reps:'10 por perna', weight:0, rest:120, notes:''},
      {id:uid(), name:'Remada serrote unilateral', sets:3, reps:'10-12 por braço', weight:0, rest:90, notes:''},
      {id:uid(), name:'Crucifixo invertido (máquina/halteres)', sets:3, reps:'12', weight:0, rest:90, notes:''},
      {id:uid(), name:'Thrusters com halteres', sets:1, reps:'21-15-9', weight:0, rest:0, notes:'WOD "For Time" (o mais rápido)'},
      {id:uid(), name:'Remada TRX ou puxada no pulley', sets:1, reps:'21-15-9', weight:0, rest:0, notes:'WOD "For Time"'},
    ]},
    { id:uid(), name:'Treino F — Cardio Leve + Skill', order:5, exercises:[
      {id:uid(), name:'Bicicleta ergométrica', sets:1, reps:'30-40 min', weight:0, rest:0, notes:'Só bike · ritmo leve/passeio'},
      {id:uid(), name:'Skill (técnica)', sets:1, reps:'15 min', weight:0, rest:0, notes:'Educativos para core e sustentação'},
    ]},
  ];
}

/* ===================================================================
   NAVEGAÇÃO ENTRE TELAS
   =================================================================== */
const TITLES = { workouts:'Meus Treinos', history:'Histórico', progress:'Progresso', settings:'Ajustes' };
function show(view){
  state.view = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  $('view-'+view).classList.add('active');
  document.querySelector('main').scrollTop = 0;
  // nav tabs
  const tab = (view==='detail'||view==='session') ? 'workouts' : view;
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  moveNavInd();
  // back button + title
  const back = (view==='detail'||view==='session'||view==='progress'&&false);
  $('backBtn').hidden = !(view==='detail'||view==='session');
  if(view==='detail'){ const w=curWorkout(); $('hdrTitle').textContent = w?w.name:'Treino'; }
  else if(view==='session'){ $('hdrTitle').textContent = state.session? state.session.name : 'Treino'; }
  else $('hdrTitle').textContent = TITLES[view]||'Treino';
}
function moveNavInd(){
  const ind=document.querySelector('.nav-ind');
  const btn=document.querySelector('nav button.active');
  if(!ind||!btn) return;
  const x = btn.offsetLeft + btn.offsetWidth/2 - ind.offsetWidth/2;
  ind.style.left = Math.round(x)+'px';
}
addEventListener('resize', ()=>{ requestAnimationFrame(moveNavInd); });
function curWorkout(){ return state.workouts.find(w=>w.id===state.detailId); }

/* ===================================================================
   TELA: LISTA DE TREINOS
   =================================================================== */
function renderWorkouts(){
  const el = $('view-workouts');
  const list = [...state.workouts].sort((a,b)=>a.order-b.order);
  const draftBanner = state.draft ? `
    <div class="card tap" id="resumeCard" style="border-color:var(--accent);background:var(--accent-soft);margin-bottom:16px">
      <div class="row spread">
        <div style="min-width:0">
          <div class="tiny" style="color:var(--accent);font-weight:800;text-transform:uppercase;letter-spacing:.05em">Treino em andamento</div>
          <div style="font-weight:700;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(state.draft.name)}</div>
          <div class="small muted" style="margin-top:2px">Toque pra continuar de onde parou</div>
        </div>
        <div style="color:var(--accent);font-size:22px"><i class="fa-solid fa-play"></i></div>
      </div>
    </div>` : '';
  if(!list.length){
    el.innerHTML = draftBanner + `<div class="empty"><div class="big"><i class="fa-solid fa-dumbbell"></i></div>
      <p>Nenhum treino ainda.<br>Crie o seu primeiro!</p></div>`;
  } else {
    el.innerHTML = draftBanner + `<div class="sec-head"><h2>Seus treinos</h2></div>` +
      list.map(w=>{
        const n = w.exercises.length;
        const last = lastSessionOf(w.id);
        return `<div class="card tap" data-open="${w.id}">
          <div class="row spread">
            <div style="min-width:0">
              <h3 style="font-size:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(w.name)}</h3>
              <div class="small muted" style="margin-top:3px">${n} exercício${n!==1?'s':''}${last?' · último: '+fmtDate(last.date):''}</div>
            </div>
            <div class="muted" style="font-size:22px">›</div>
          </div>
        </div>`;
      }).join('');
  }
  const rc=$('resumeCard'); if(rc) rc.onclick = resumeSession;
  if(!$('fab-workouts')){
    const fab = document.createElement('button');
    fab.className='fab'; fab.id='fab-workouts'; fab.textContent='+';
    fab.title='Novo treino'; fab.onclick=()=>editWorkout(null);
    el.appendChild(fab);
  } else el.appendChild($('fab-workouts'));
}
function lastSessionOf(wid){
  return state.sessions.filter(s=>s.workoutId===wid).sort((a,b)=>b.date-a.date)[0];
}

/* ===================================================================
   TELA: DETALHE DO TREINO
   =================================================================== */
function renderDetail(){
  const w = curWorkout(); if(!w){ show('workouts'); return; }
  const el = $('view-detail');
  el.innerHTML = `
    <div class="btn-stack" style="margin-bottom:18px">
      <button class="btn primary" id="startBtn"><i class="fa-solid fa-play"></i>  Iniciar treino</button>
    </div>
    <div class="sec-head">
      <h2>Exercícios (${w.exercises.length})</h2>
      <div class="row" style="gap:8px">
        <button class="btn ghost sm" id="addSetBtn"><i class="fa-solid fa-repeat"></i> Set</button>
        <button class="btn ghost sm" id="addExBtn">+ Exercício</button>
      </div>
    </div>
    <div id="exList"></div>
    <div class="btn-stack" style="margin-top:20px">
      <button class="btn ghost sm" id="editWBtn" style="width:100%"><i class="fa-solid fa-pen"></i>  Renomear treino</button>
      <button class="btn danger sm" id="delWBtn" style="width:100%">Excluir treino</button>
    </div>`;
  const listEl = $('exList');
  const exRow = (ex, drag)=>`
      <div class="ex${drag?'':' nodrag'}" ${drag?'draggable="true"':''} data-ex="${ex.id}">
        <span class="grip">≡</span>
        <div class="body" data-editex="${ex.id}">
          <div class="name">${esc(ex.name)}</div>
          <div class="tag-row">
            ${ex.mode==='tempo'
              ? `<span class="chip accent"><i class="fa-solid fa-clock"></i> ${esc(ex.reps)} min</span>`
              : `<span class="chip">${ex.group?'':ex.sets+'×'}${esc(ex.reps)}</span>${ex.weight?`<span class="chip accent">${ex.weight} kg</span>`:''}`}
            ${ex.group?'':`<span class="chip"><i class="fa-solid fa-stopwatch"></i> ${ex.rest}s</span>`}
            ${ex.notes?`<span class="chip"><i class="fa-solid fa-note-sticky"></i> ${esc(ex.notes)}</span>`:''}
          </div>
        </div>
      </div>`;
  const setBlock = (g)=>{
    const exs = w.exercises.filter(e=>e.group===g.id);
    return `<div class="set-detail" data-grp="${g.id}">
      <div class="set-detail-h">
        <span><i class="fa-solid fa-repeat"></i> ${esc(g.name||'Set')} · ${g.rounds||1}×  <span class="tiny muted">· descanso ${g.rest}s</span></span>
        <button class="link small" data-editgrp="${g.id}">editar</button>
      </div>
      ${exs.length ? exs.map(e=>exRow(e,false)).join('') : `<p class="muted small" style="padding:4px 2px">Set vazio — adicione exercícios.</p>`}
      <button class="link small" data-addexset="${g.id}" style="display:block;margin:8px 2px 2px">+ exercício no set</button>
    </div>`;
  };
  const hasAnything = w.exercises.length || (w.groups && w.groups.length);
  if(!hasAnything){
    listEl.innerHTML = `<p class="muted small" style="padding:8px 2px">Nenhum exercício. Toque em “+ Exercício” ou “Set”.</p>`;
  } else {
    let htmlOut=''; const emitted=new Set();
    orderedExercises(w).forEach(ex=>{
      if(ex.group){
        if(emitted.has(ex.group)) return;
        emitted.add(ex.group);
        const g = groupOf(w, ex.group) || {id:ex.group, rounds:1, rest:60, name:''};
        htmlOut += setBlock(g);
      } else {
        htmlOut += exRow(ex, true);
      }
    });
    // Sets ainda sem exercícios (recém-criados)
    (w.groups||[]).forEach(g=>{ if(!emitted.has(g.id)){ emitted.add(g.id); htmlOut += setBlock(g); } });
    listEl.innerHTML = htmlOut;
    if(!(w.groups && w.groups.length)) enableDragSort(listEl, w);
  }
  $('startBtn').onclick = ()=>startSession(w.id);
  $('addExBtn').onclick = ()=>editExercise(w.id, null);
  $('addSetBtn').onclick = ()=>editSet(w.id, null);
  $('editWBtn').onclick = ()=>editWorkout(w.id);
  $('delWBtn').onclick = ()=>confirmDelWorkout(w);
  listEl.querySelectorAll('[data-editex]').forEach(n=>{
    n.onclick = ()=>editExercise(w.id, n.dataset.editex);
  });
  listEl.querySelectorAll('[data-editgrp]').forEach(n=>{
    n.onclick = ()=>editSet(w.id, n.dataset.editgrp);
  });
  listEl.querySelectorAll('[data-addexset]').forEach(n=>{
    n.onclick = ()=>editExercise(w.id, null, n.dataset.addexset);
  });
}

/* arrastar p/ reordenar exercícios */
function enableDragSort(container, w){
  let dragEl=null;
  container.querySelectorAll('.ex').forEach(item=>{
    item.addEventListener('dragstart',()=>{ dragEl=item; item.classList.add('drag'); });
    item.addEventListener('dragend',async()=>{
      item.classList.remove('drag');
      container.querySelectorAll('.ex').forEach(x=>x.classList.remove('over'));
      const ids=[...container.querySelectorAll('.ex')].map(x=>x.dataset.ex);
      w.exercises.sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));
      await DB.put('workouts', JSON.parse(JSON.stringify(w)));
    });
    item.addEventListener('dragover',e=>{
      e.preventDefault();
      const r=item.getBoundingClientRect();
      const after=e.clientY > r.top + r.height/2;
      if(dragEl && dragEl!==item){
        container.insertBefore(dragEl, after? item.nextSibling : item);
      }
    });
  });
}

/* ===================================================================
   TELA: SESSÃO ATIVA (marcar séries + cronômetro)
   =================================================================== */
/* exercícios na ordem certa: os de um mesmo Set ficam juntos (consecutivos) */
function orderedExercises(w){
  const out=[]; const seen=new Set();
  (w.exercises||[]).forEach(ex=>{
    if(ex.group){
      if(seen.has(ex.group)) return;
      seen.add(ex.group);
      w.exercises.filter(e=>e.group===ex.group).forEach(e=>out.push(e));
    } else out.push(ex);
  });
  return out;
}
function groupOf(w, gid){ return (w.groups||[]).find(g=>g.id===gid); }

function startSession(wid){
  const w = state.workouts.find(x=>x.id===wid); if(!w) return;
  // pré-preenche com últimos pesos usados, se houver histórico
  const prev = lastSessionOf(wid);
  state.session = {
    id: uid(), workoutId: w.id, name: w.name, date: Date.now(), startedAt: Date.now(),
    entries: orderedExercises(w).map(ex=>{
      const old = prev && prev.entries.find(e=>e.exerciseId===ex.id);
      const tempo = ex.mode==='tempo';
      const grp = ex.group ? groupOf(w, ex.group) : null;
      const nSets = grp ? (grp.rounds||1) : ex.sets;
      const rest = grp ? grp.rest : ex.rest;
      return {
        exerciseId: ex.id, name: ex.name, reps: ex.reps, rest, mode: ex.mode||'reps',
        group: ex.group||null, groupName: grp?(grp.name||''):'', groupRounds: grp?(grp.rounds||1):0,
        sets: Array.from({length: nSets}, (_,i)=>({
          weight: tempo ? 0 : (old && old.sets[i]? old.sets[i].weight : (ex.weight||0)),
          reps: old && old.sets[i]? old.sets[i].reps : (tempo ? (ex.reps||'') : ''),
          done: false
        }))
      };
    })
  };
  saveDraft();              // já guarda o rascunho (pré-save)
  renderSession(); show('session');
}
/* retoma um treino não finalizado (rascunho) */
function resumeSession(){
  if(!state.draft) return;
  state.session = JSON.parse(JSON.stringify(state.draft));
  renderSession(); show('session');
}
/* ---------- Rascunho (pré-save): sobrevive a fechar o app ----------
   Salva na HORA no aparelho (localStorage, não perde ao fechar) e também
   no banco (Firestore, com debounce) pra sincronizar entre aparelhos. */
let draftTimer=null;
function saveDraft(){
  if(!state.session) return;
  const copy = JSON.parse(JSON.stringify(state.session));
  state.draft = copy;
  try{ localStorage.setItem('draft', JSON.stringify(copy)); }catch(e){}   // instantâneo e confiável
  clearTimeout(draftTimer);
  draftTimer = setTimeout(()=>{ try{ DB.put('drafts', {id:'active', ...copy}); }catch(e){} }, 600);  // nuvem
}
function scheduleDraftSave(){ saveDraft(); }   // localStorage já é imediato
async function clearDraft(){
  state.draft = null;
  try{ localStorage.removeItem('draft'); }catch(e){}
  try{ await DB.del('drafts','active'); }catch(e){}
}
async function loadDraft(){
  // 1) tenta o banco (sincroniza entre aparelhos)
  try{ const d = await DB.get('drafts','active'); if(d && d.entries && d.entries.length){ state.draft = d; return; } }catch(e){}
  // 2) cai pro aparelho (localStorage)
  try{ const ls = localStorage.getItem('draft'); if(ls){ const d = JSON.parse(ls); if(d && d.entries && d.entries.length){ state.draft = d; return; } } }catch(e){}
  state.draft = null;
}

/* inputs de uma série (kg/reps ou minutos) */
function setInputs(e, st){
  return e.mode==='tempo'
    ? `<input type="number" inputmode="numeric" min="0" step="any" placeholder="min" value="${st.reps??''}" data-f="reps" onfocus="if(this.value==='0')this.value='';this.select()"><span class="u">min</span>`
    : `<input type="number" inputmode="decimal" min="0" step="any" placeholder="kg" value="${st.weight??''}" data-f="weight" onfocus="if(this.value==='0')this.value='';this.select()"><input type="number" inputmode="numeric" min="0" step="1" placeholder="reps" value="${st.reps??''}" data-f="reps" onfocus="if(this.value==='0')this.value='';this.select()">`;
}
/* card de um exercício solto */
function renderExerciseCard(e, ei){
  return `
    <div class="card">
      <h3 style="font-size:16px;margin-bottom:2px">${esc(e.name)}</h3>
      <div class="tiny muted" style="margin-bottom:10px">Meta: ${esc(e.reps)}${e.mode==='tempo'?' min':' reps'} · descanso ${e.rest}s</div>
      ${e.mode==='tempo'
        ? `<div class="col-head"><span>Minutos</span><span class="sp"></span></div>`
        : `<div class="col-head"><span>Kg</span><span>Reps</span><span class="sp"></span></div>`}
      ${e.sets.map((st,si)=>`
        <div class="set-wrap" data-ei="${ei}" data-si="${si}">
          <button class="set-del" data-del aria-label="remover série"><i class="fa-solid fa-trash"></i></button>
          <div class="set-line ${st.done?'done':''}" data-ei="${ei}" data-si="${si}">
            <span class="set-no">${si+1}</span>
            ${setInputs(e, st)}
            <button class="chk ${st.done?'on':''}" data-chk aria-label="feito"><i class="fa-solid fa-check"></i></button>
          </div>
        </div>`).join('')}
      <div class="row" style="gap:12px;margin-top:12px;align-items:center">
        <button class="btn sm" data-rest="${ei}" style="background:var(--accent2-soft);color:var(--accent2)"><i class="fa-solid fa-stopwatch"></i> Descansar ${e.rest}s</button>
        <button class="link small" data-addset="${ei}">+ série</button>
      </div>
    </div>`;
}
/* bloco de um Set (vários exercícios repetidos em voltas) */
function renderSetBlock(members){
  const first = members[0].e;
  const rounds = first.sets.length;
  const restEi = members[0].ei;
  const rest = first.rest;
  const title = first.groupName ? esc(first.groupName) : 'Set';
  let rows='';
  for(let r=0;r<rounds;r++){
    let exRows='';
    members.forEach(({e,ei})=>{
      const st=e.sets[r];
      exRows += `
        <div class="set-line in-set ${st.done?'done':''}" data-ei="${ei}" data-si="${r}">
          <span class="ex-name">${esc(e.name)}</span>
          ${setInputs(e, st)}
          <button class="chk ${st.done?'on':''}" data-chk aria-label="feito"><i class="fa-solid fa-check"></i></button>
        </div>`;
    });
    rows += `
      <div class="set-round">
        <div class="set-round-h">Set ${r+1}</div>
        ${exRows}
        ${r<rounds-1 ? `<button class="btn sm" data-rest="${restEi}" style="background:var(--accent2-soft);color:var(--accent2);margin-top:8px"><i class="fa-solid fa-stopwatch"></i> Descansar ${rest}s</button>` : ''}
      </div>`;
  }
  return `
    <div class="card set-block">
      <div class="row spread" style="margin-bottom:2px">
        <h3 style="font-size:16px;display:flex;align-items:center;gap:7px"><i class="fa-solid fa-repeat" style="color:var(--accent2)"></i> ${title}</h3>
        <span class="chip accent">${rounds}×</span>
      </div>
      <div class="tiny muted" style="margin-bottom:10px">Faz em sequência · descansa ${rest}s · repete</div>
      ${rows}
    </div>`;
}
/* monta os cards da sessão, agrupando os Sets */
function sessionEntriesHtml(entries){
  let html=''; let i=0;
  while(i<entries.length){
    const e=entries[i];
    if(e.group){
      const gid=e.group; const members=[]; let j=i;
      while(j<entries.length && entries[j].group===gid){ members.push({e:entries[j], ei:j}); j++; }
      html += renderSetBlock(members); i=j;
    } else { html += renderExerciseCard(e, i); i++; }
  }
  return html;
}

function renderSession(){
  const s = state.session; if(!s){ show('workouts'); return; }
  const el = $('view-session');
  const totalSets = s.entries.reduce((a,e)=>a+e.sets.length,0);
  const doneSets = s.entries.reduce((a,e)=>a+e.sets.filter(x=>x.done).length,0);
  el.innerHTML = `
    <div class="card" style="background:var(--accent-soft);border-color:transparent">
      <div class="row spread">
        <div><div class="tiny muted" style="text-transform:uppercase;letter-spacing:.05em">Em andamento</div>
          <div style="font-weight:800;font-size:17px;margin-top:2px">${esc(s.name)}</div></div>
        <div style="text-align:right"><div style="font-weight:800;font-size:17px">${doneSets}/${totalSets}</div>
          <div class="tiny muted">séries</div></div>
      </div>
    </div>
    ${sessionEntriesHtml(s.entries)}
    <div class="tiny muted" style="text-align:center;margin:10px 0 2px"><i class="fa-solid fa-cloud"></i> Salvo automaticamente — pode fechar e voltar quando quiser</div>
    <div class="btn-stack" style="margin-top:6px">
      <button class="btn ok" id="finishBtn"><i class="fa-solid fa-flag-checkered"></i>  Finalizar treino</button>
      <button class="btn danger sm" id="cancelBtn" style="width:100%">Descartar treino</button>
    </div>`;

  // inputs -> state
  el.querySelectorAll('.set-line input').forEach(inp=>{
    inp.oninput = ()=>{
      const l=inp.closest('.set-line');
      if(inp.value!=='' && parseFloat(inp.value)<0) inp.value='0';   // sem negativos
      state.session.entries[+l.dataset.ei].sets[+l.dataset.si][inp.dataset.f] = inp.value;
      scheduleDraftSave();
    };
  });
  // check -> marca feito + inicia descanso
  el.querySelectorAll('[data-chk]').forEach(btn=>{
    btn.onclick = ()=>{
      const l=btn.closest('.set-line');
      const st=state.session.entries[+l.dataset.ei].sets[+l.dataset.si];
      st.done = !st.done;
      btn.classList.toggle('on', st.done);
      l.classList.toggle('done', st.done);
      updateSessionCount();
      scheduleDraftSave();
      // NÃO inicia o descanso automaticamente — você dispara no botão "Descansar"
    };
  });
  el.querySelectorAll('[data-addset]').forEach(b=>{
    b.onclick = ()=>{
      const e=state.session.entries[+b.dataset.addset];
      const last=e.sets[e.sets.length-1];
      e.sets.push({weight:last?last.weight:0, reps:'', done:false});
      scheduleDraftSave();
      renderSession();
    };
  });
  el.querySelectorAll('[data-rest]').forEach(b=>{
    b.onclick = ()=>{ const e=state.session.entries[+b.dataset.rest]; triggerRest(e.rest); };
  });
  bindSwipeDelete(el);
  $('finishBtn').onclick = finishSession;
  $('cancelBtn').onclick = cancelSession;
}

/* deslizar a série pro lado -> revela lixeira pra remover */
function bindSwipeDelete(el){
  el.querySelectorAll('.set-wrap').forEach(wrap=>{
    const line = wrap.querySelector('.set-line');
    let x0=0,y0=0,dx=0,drag=false,decided=false;
    line.addEventListener('touchstart', e=>{
      const t=e.touches[0]; x0=t.clientX; y0=t.clientY; dx=0; drag=false; decided=false;
      line.style.transition='none';
    }, {passive:true});
    line.addEventListener('touchmove', e=>{
      const t=e.touches[0], mx=t.clientX-x0, my=t.clientY-y0;
      if(!decided && (Math.abs(mx)>8 || Math.abs(my)>8)){ decided=true; drag=Math.abs(mx)>Math.abs(my); }
      if(drag){
        e.preventDefault();
        const base = wrap.classList.contains('open') ? -72 : 0;
        dx = Math.max(-72, Math.min(0, base+mx));
        line.style.transform='translateX('+dx+'px)';
      }
    }, {passive:false});
    line.addEventListener('touchend', ()=>{
      line.style.transition=''; line.style.transform='';
      if(drag){
        const open = dx < -36;
        el.querySelectorAll('.set-wrap.open').forEach(w=>{ if(w!==wrap) w.classList.remove('open'); });
        wrap.classList.toggle('open', open);
      }
    });
    wrap.querySelector('[data-del]').onclick = ()=>{
      const ei=+wrap.dataset.ei, si=+wrap.dataset.si;
      const entry=state.session.entries[ei];
      if(entry.sets.length<=1){ toast('Precisa ter ao menos 1 série'); wrap.classList.remove('open'); return; }
      entry.sets.splice(si,1);
      scheduleDraftSave();
      renderSession();
    };
  });
}
function updateSessionCount(){
  const s=state.session; if(!s) return;
  const total=s.entries.reduce((a,e)=>a+e.sets.length,0);
  const done=s.entries.reduce((a,e)=>a+e.sets.filter(x=>x.done).length,0);
  const card=$('view-session').querySelector('.card');
  if(card){ const nums=card.querySelectorAll('div[style*="font-weight:800"]'); }
  // simples: re-render do contador no topo
  const top=$('view-session').querySelector('.card .row.spread > div:last-child');
  if(top) top.querySelector('div').textContent = `${done}/${total}`;
}
async function finishSession(){
  const s = state.session; if(!s) return;
  // registra as séries marcadas OU com repetições preenchidas (sem bloquear)
  const entries = s.entries
    .map(e=>({...e, sets: e.sets.filter(st=> st.done || (st.reps!=='' && st.reps!=null && parseFloat(st.reps)>0) )}))
    .filter(e=>e.sets.length);
  state.session = null; await clearDraft(); stopRest();   // encerra e limpa o rascunho — já estava tudo salvo
  if(entries.length){
    const saved = JSON.parse(JSON.stringify(s));
    saved.entries = entries;
    saved.endedAt = Date.now();
    saved.durationMs = s.startedAt ? (saved.endedAt - s.startedAt) : null;
    saved.sets = entries.reduce((a,e)=>a+e.sets.length,0);
    saved.volume = entries.reduce((a,e)=>a+e.sets.reduce((x,st)=>x+(parseFloat(st.weight)||0)*(parseFloat(st.reps)||0),0),0);
    try{ await DB.put('sessions', saved); }catch(e){ console.error(e); }
    state.sessions.push(saved);
    toast('Treino finalizado! 💪');
    show('history'); renderHistory();
  } else {
    toast('Treino encerrado');
    show('workouts'); renderWorkouts();
  }
}
/* sai do treino mantendo o rascunho (continua salvo automaticamente) */
async function pauseSession(){
  if(!state.session) return;
  saveDraft();
  stopRest();
  state.session = null;
  show('workouts'); renderWorkouts();
}
function cancelSession(){
  showConfirm('Descartar treino?', 'As séries deste treino em andamento serão apagadas.', 'Descartar', async()=>{
    state.session=null; await clearDraft(); stopRest(); closeSheet(); show('workouts'); renderWorkouts();
  });
}

/* ---------- Disparo do descanso: no app ou timer nativo (Atalhos) ---------- */
function triggerRest(sec){
  if(sec<=0) return;
  const mode = localStorage.getItem('restMode') || 'app';
  if(mode==='native') startNativeTimer(sec);
  else startRest(sec);
}
function startNativeTimer(sec){
  const name = localStorage.getItem('shortcutName') || 'Descanso';
  toast('Abrindo timer nativo ('+sec+'s)…');
  // dispara o Atalho da Apple, que inicia um timer nativo (toca em background)
  const url = `shortcuts://run-shortcut?name=${encodeURIComponent(name)}&input=text&text=${sec}`;
  window.location.href = url;
}

/* ---------- Cronômetro de descanso (no app) ----------
   Baseado em HORÁRIO-ALVO (timestamp), não em contagem por tick.
   Se o iOS pausar o JS (app em segundo plano / tela bloqueada), ao voltar
   o tempo mostrado fica correto na hora — e se já acabou, avisa na hora.
   Mantém a tela acordada (Wake Lock) durante o descanso. */
let restInt=null, restEnd=0, restDone=false, wakeLock=null, audioCtx=null;
function ensureAudio(){ try{ audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)(); if(audioCtx.state==='suspended') audioCtx.resume(); }catch(e){} }
function beep(){
  try{
    ensureAudio(); if(!audioCtx) return;
    [0,160,320].forEach(delay=>{
      const o=audioCtx.createOscillator(), g=audioCtx.createGain();
      o.frequency.value=880; o.type='sine'; o.connect(g); g.connect(audioCtx.destination);
      const t=audioCtx.currentTime + delay/1000;
      g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(.35,t+.02);
      g.gain.exponentialRampToValueAtTime(.0001,t+.14);
      o.start(t); o.stop(t+.16);
    });
  }catch(e){}
  if(navigator.vibrate) navigator.vibrate([200,80,200]);  // iOS ignora, mas não atrapalha
}
async function requestWakeLock(){
  try{ if('wakeLock' in navigator){ wakeLock = await navigator.wakeLock.request('screen'); } }catch(e){}
}
function releaseWakeLock(){ try{ if(wakeLock){ wakeLock.release(); wakeLock=null; } }catch(e){} }

function startRest(sec){
  ensureAudio();
  restEnd = Date.now() + sec*1000;
  restDone = false;
  const bar=$('rest'); bar.classList.add('show'); bar.classList.remove('done');
  if($('restLbl')) $('restLbl').textContent='Descanso';
  if($('restSkip')) $('restSkip').textContent='Pular';
  requestWakeLock();
  drawRest();
  clearInterval(restInt);
  restInt=setInterval(tickRest, 250);
}
function tickRest(){
  const left = Math.ceil((restEnd - Date.now())/1000);
  drawRest(left);
  if(left<=0 && !restDone){
    restDone=true;
    clearInterval(restInt); restInt=null;
    releaseWakeLock();
    beep();
    const bar=$('rest'); bar.classList.add('done');
    if($('restLbl')) $('restLbl').textContent='Acabou!';
    if($('restSkip')) $('restSkip').textContent='OK';
    toast('Descanso acabou!');
  }
}
function drawRest(left){
  if(left===undefined) left = Math.ceil((restEnd - Date.now())/1000);
  $('restT').textContent = mmss(Math.max(0,left));
}
function stopRest(){
  clearInterval(restInt); restInt=null; restEnd=0; restDone=false;
  releaseWakeLock();
  const bar=$('rest'); bar.classList.remove('show'); bar.classList.remove('done');
}

/* ===================================================================
   TELA: HISTÓRICO
   =================================================================== */
let histView = (()=>{ try{ return localStorage.getItem('histView')||'lista'; }catch(e){ return 'lista'; } })();
let calRef = (()=>{ const d=new Date(); d.setDate(1); return d; })();

function renderHistory(){
  const el = $('view-history');
  const list = [...state.sessions].sort((a,b)=>b.date-a.date);
  const toggle = `<div class="seg">
    <button class="${histView==='lista'?'on':''}" data-hv="lista">Lista</button>
    <button class="${histView==='calendario'?'on':''}" data-hv="calendario">Calendário</button>
  </div>`;
  const bindToggle = ()=> el.querySelectorAll('[data-hv]').forEach(b=>b.onclick=()=>{
    histView=b.dataset.hv; try{localStorage.setItem('histView',histView);}catch(e){} renderHistory();
  });

  if(histView==='calendario'){
    el.innerHTML = toggle + renderCalendarHTML();
    bindToggle(); bindCalendar(el);
    return;
  }

  if(!list.length){
    el.innerHTML = toggle + `<div class="empty"><div class="big"><i class="fa-solid fa-calendar"></i></div>
      <p>Nenhum treino registrado ainda.<br>Faça um treino e ele aparece aqui.</p></div>`;
    bindToggle(); return;
  }

  let html=toggle; let curDay='';
  list.forEach(s=>{
    const d=dayKey(s.date);
    if(d!==curDay){ curDay=d; html+=`<div class="hist-date">${d}</div>`; }
    html += `<div class="card tap" data-sess="${s.id}">
      <div class="row spread">
        <div style="min-width:0"><h3 style="font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</h3>
          <div class="small muted" style="margin-top:3px">${s.entries.length} exercícios · ${s.sets||0} séries${s.durationMs?' · '+fmtDur(s.durationMs):''}</div></div>
        <div class="muted" style="font-size:22px">›</div>
      </div></div>`;
  });
  el.innerHTML = html;
  bindToggle();
}

/* ---------- Calendário do histórico ---------- */
function sessionDayKeys(){
  const set = new Set();
  state.sessions.forEach(s=>{ const d=new Date(s.date); set.add(d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate()); });
  return set;
}
function renderCalendarHTML(){
  const y=calRef.getFullYear(), m=calRef.getMonth();
  const monthName=calRef.toLocaleDateString('pt-BR',{month:'long',year:'numeric'});
  const startDow=new Date(y,m,1).getDay();          // 0=Dom
  const days=new Date(y,m+1,0).getDate();
  const marked=sessionDayKeys();
  const t=new Date(); const todayKey=t.getFullYear()+'-'+t.getMonth()+'-'+t.getDate();
  const wd=['D','S','T','Q','Q','S','S'];
  let cells='';
  for(let i=0;i<startDow;i++) cells+=`<div class="cal-cell empty"></div>`;
  let count=0;
  for(let d=1; d<=days; d++){
    const key=y+'-'+m+'-'+d;
    const mk=marked.has(key); if(mk) count++;
    const td=key===todayKey;
    cells+=`<div class="cal-cell ${mk?'marked':''} ${td?'today':''}" ${mk?`data-day="${d}"`:''}>${d}</div>`;
  }
  return `<div class="card">
    <div class="cal-head">
      <button class="cal-nav" data-cal="-1">‹</button>
      <div class="cal-title">${monthName}</div>
      <button class="cal-nav" data-cal="1">›</button>
    </div>
    <div class="cal-grid wd">${wd.map(w=>`<div class="cal-wd">${w}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-foot">${count} treino${count!==1?'s':''} neste mês · toque num dia marcado pra ver</div>
  </div>`;
}
function bindCalendar(el){
  el.querySelectorAll('[data-cal]').forEach(b=>b.onclick=()=>{
    calRef.setMonth(calRef.getMonth()+Number(b.dataset.cal)); renderHistory();
  });
  el.querySelectorAll('[data-day]').forEach(c=>c.onclick=()=>{
    const d=Number(c.dataset.day), y=calRef.getFullYear(), m=calRef.getMonth();
    const sess=state.sessions.filter(s=>{const dt=new Date(s.date);return dt.getFullYear()===y&&dt.getMonth()===m&&dt.getDate()===d;}).sort((a,b)=>b.date-a.date);
    if(sess.length===1) openSession(sess[0].id);
    else if(sess.length>1) openDayList(sess);
  });
}
function openDayList(sess){
  const title=new Date(sess[0].date).toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long'});
  openSheet(`<h2 style="text-transform:capitalize">${esc(title)}</h2>`+
    sess.map(s=>`<div class="card tap" data-ds="${s.id}" style="margin:0 0 10px">
      <b>${esc(s.name)}</b><div class="small muted" style="margin-top:3px">${s.entries.length} exercícios · ${s.sets||0} séries</div></div>`).join(''));
  $('sheet').querySelectorAll('[data-ds]').forEach(c=>c.onclick=()=>openSession(c.dataset.ds));
}
function openSession(id){
  const s = state.sessions.find(x=>x.id===id); if(!s) return;
  const quando = new Date(s.date).toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'short'});
  const horario = s.startedAt ? `${hhmm(s.startedAt)}${s.endedAt?' – '+hhmm(s.endedAt):''}` : new Date(s.date).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const dur = s.durationMs ? fmtDur(s.durationMs) : '';
  const body = `
    <h2>${esc(s.name)}</h2>
    <div class="small muted" style="margin:-8px 0 8px;text-transform:capitalize">${quando} · ${horario}</div>
    ${dur?`<div class="chip accent" style="margin-bottom:14px"><i class="fa-solid fa-clock"></i> durou ${dur}</div>`:''}
    ${s.entries.map(e=>`
      <div style="margin-bottom:16px">
        <div style="font-weight:700;margin-bottom:6px">${esc(e.name)}</div>
        ${e.sets.map((st,i)=>`<div class="small" style="padding:3px 0;border-bottom:1px solid var(--line)">
          <span class="muted">Série ${i+1}:</span> ${e.mode==='tempo'
            ? `<b>${st.reps||'-'} min</b>`
            : `<b>${st.weight||0} kg</b> × ${st.reps||'-'} reps`}</div>`).join('')}
      </div>`).join('')}
    <div class="btn-stack" style="margin-top:8px">
      <button class="btn danger sm" style="width:100%" id="delSess">Excluir este registro</button>
    </div>`;
  openSheet(body);
  $('delSess').onclick = ()=>{
    showConfirm('Excluir registro?','Essa ação não pode ser desfeita.','Excluir',async()=>{
      await DB.del('sessions', id);
      state.sessions = state.sessions.filter(x=>x.id!==id);
      closeSheet(); renderHistory();
    });
  };
}

/* ===================================================================
   TELA: PROGRESSO (evolução de carga por exercício)
   =================================================================== */
function renderProgress(){
  const el = $('view-progress');
  // agrupa melhor peso por exercício ao longo das sessões
  const byEx = {};
  [...state.sessions].sort((a,b)=>a.date-b.date).forEach(s=>{
    s.entries.forEach(e=>{
      const top = Math.max(0, ...e.sets.map(x=>parseFloat(x.weight)||0));
      if(!top) return;
      (byEx[e.name] = byEx[e.name]||[]).push({date:s.date, w:top});
    });
  });
  const names = Object.keys(byEx).filter(n=>byEx[n].length>=1)
    .sort((a,b)=>byEx[b].length-byEx[a].length);
  if(!names.length){
    el.innerHTML = `<div class="empty"><div class="big"><i class="fa-solid fa-chart-line"></i></div>
      <p>Sem dados de progresso ainda.<br>Registre alguns treinos pra ver a evolução da carga.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="sec-head"><h2>Evolução da carga</h2></div>` +
    names.map(n=>{
      const pts = byEx[n].slice(-12);
      const max = Math.max(...pts.map(p=>p.w));
      const first = pts[0].w, last = pts[pts.length-1].w;
      const diff = last-first;
      const bars = pts.map((p,i)=>`<div class="bar ${i===pts.length-1?'last':''}"
        style="height:${Math.max(8,Math.round(p.w/max*100))}%" title="${p.w}kg"></div>`).join('');
      return `<div class="card">
        <div class="progress-ex">${esc(n)}</div>
        <div class="row spread small">
          <span class="muted">Atual: <b style="color:var(--fg)">${last} kg</b></span>
          <span class="${diff>0?'pr':'muted'}">${diff>0?'▲ +'+diff+' kg':(diff<0?'▼ '+diff+' kg':'= estável')}</span>
        </div>
        <div class="spark">${bars}</div>
      </div>`;
    }).join('');
}

/* ===================================================================
   TELA: AJUSTES (backup / tema / limpar)
   =================================================================== */
function renderSettings(){
  const el = $('view-settings');
  const online = navigator.onLine;
  el.innerHTML = `
    <div class="sec-head"><h2>Servidor</h2></div>
    <div class="card">
      <div class="small muted">Conectado ao homeserver</div>
      <div style="font-weight:700;margin:2px 0 10px;overflow:hidden;text-overflow:ellipsis">${esc(DB.host()||'—')}</div>
      <div class="row small" style="gap:6px">
        <span id="srvDot" style="color:var(--muted);font-size:10px">●</span>
        <span class="muted" id="srvTxt">…</span>
      </div>
      <button class="btn ghost sm" id="syncBtn" style="width:100%;margin-top:14px">Sincronizar agora</button>
      <button class="btn ghost sm" id="logoutBtn" style="width:100%;margin-top:8px">Trocar servidor</button>
    </div>

    <div class="sec-head"><h2>Backup manual</h2></div>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">Seus dados já ficam salvos no seu servidor. Se quiser, exporte também um arquivo de segurança no seu aparelho.</p>
      <div class="btn-stack">
        <button class="btn primary sm" id="expBtn" style="width:100%"><i class="fa-solid fa-download"></i>  Exportar backup</button>
        <button class="btn ghost sm" id="impBtn" style="width:100%"><i class="fa-solid fa-upload"></i>  Importar backup</button>
        <input type="file" id="impFile" accept="application/json" hidden>
      </div>
    </div>
    <div class="sec-head"><h2>Cronômetro de descanso</h2></div>
    <div class="card">
      <div class="field" style="margin:0">
        <label>Como disparar o timer</label>
        <select id="restModeSel">
          <option value="app">No app — fluido, mas precisa da tela ligada</option>
          <option value="native">Nativo do iPhone (Atalhos) — toca em segundo plano</option>
        </select>
      </div>
      <div class="field" id="shortcutNameField" hidden style="margin:14px 0 0">
        <label>Nome do Atalho</label>
        <input id="shortcutNameInput" placeholder="Descanso">
        <p class="tiny muted" style="margin:8px 0 0">Crie o Atalho uma vez — passo a passo em <b>TIMER-NATIVO.md</b>. O nome aqui precisa ser idêntico ao do Atalho no iPhone.</p>
      </div>
    </div>

    <div class="sec-head"><h2>Aparência</h2></div>
    <div class="card">
      <div class="field" style="margin:0">
        <label>Tema</label>
        <select id="themeSel">
          <option value="auto">Automático (sistema)</option>
          <option value="light">Claro</option>
          <option value="dark">Escuro</option>
        </select>
      </div>
    </div>
    <div class="sec-head"><h2>Dados</h2></div>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">${state.workouts.length} treinos · ${state.sessions.length} registros no histórico.</p>
      <button class="btn ghost sm" id="clearWBtn" style="width:100%;margin-bottom:10px">Excluir todos os treinos</button>
      <button class="btn danger sm" id="resetBtn" style="width:100%">Apagar tudo (treinos + histórico)</button>
    </div>
    <p class="tiny muted" style="text-align:center;margin-top:24px">Meu Treino · versão 51 · dados no seu homeserver</p>`;
  const srvStatus = ()=>{
    const dot=$('srvDot'), txt=$('srvTxt'); if(!dot||!txt) return;
    const n=DB.pendingCount();
    if(DB.live()&&!n){ dot.style.color='var(--ok)'; txt.textContent='Sincronizado com o seu servidor'; }
    else if(DB.live()){ dot.style.color='var(--muted)'; txt.textContent='Enviando '+n+' alteração(ões)…'; }
    else{ dot.style.color='var(--muted)'; txt.textContent='Sem conexão com o servidor'+(n?' — '+n+' alteração(ões) esperando':'')+'. Ligue o Tailscale.'; }
  };
  srvStatus(); DB.onChange(srvStatus);
  $('syncBtn').onclick = async()=>{ await DB.flush(); try{ await DB.test(); toast('Conectado ao servidor'); }catch(e){ toast('Não consegui falar com o servidor'); } srvStatus(); };
  $('logoutBtn').onclick = ()=>{
    showConfirm('Trocar de servidor?','Seus dados continuam no servidor. Você informará o endereço e o token de novo.','Trocar',()=>{
      closeSheet(); DB.clearConfig(); showServerSetup();
    });
  };
  $('expBtn').onclick = exportBackup;
  $('impBtn').onclick = ()=>$('impFile').click();
  $('impFile').onchange = importBackup;
  $('clearWBtn').onclick = ()=>showConfirm('Excluir todos os treinos?','Apaga só os treinos — o histórico continua salvo. Vale pra todos os aparelhos.','Excluir treinos',clearWorkouts);
  $('resetBtn').onclick = ()=>showConfirm('Apagar tudo?','Todos os treinos e histórico serão apagados da nuvem (todos os aparelhos).','Apagar tudo',resetAll);
  const rm=$('restModeSel'); rm.value = localStorage.getItem('restMode')||'app';
  $('shortcutNameField').hidden = rm.value!=='native';
  $('shortcutNameInput').value = localStorage.getItem('shortcutName')||'Descanso';
  rm.onchange = ()=>{
    localStorage.setItem('restMode', rm.value);
    $('shortcutNameField').hidden = rm.value!=='native';
    if(rm.value==='native') toast('Timer nativo ativado — crie o Atalho (veja TIMER-NATIVO.md)');
  };
  $('shortcutNameInput').oninput = ()=>localStorage.setItem('shortcutName', $('shortcutNameInput').value.trim()||'Descanso');
  const sel=$('themeSel'); sel.value = localStorage.getItem('theme')||'auto';
  sel.onchange = ()=>applyTheme(sel.value);
}

function exportBackup(){
  const data = { v:1, exportedAt:Date.now(), workouts:state.workouts, sessions:state.sessions };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download = `treino-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
  toast('Backup gerado');
}
function importBackup(e){
  const file = e.target.files[0]; if(!file) return;
  const r = new FileReader();
  r.onload = async()=>{
    try{
      const d = JSON.parse(r.result);
      if(!d.workouts) throw 0;
      showConfirm('Importar backup?', `Substitui os dados atuais por ${d.workouts.length} treinos e ${(d.sessions||[]).length} registros.`, 'Importar', async()=>{
        await DB.clear('workouts'); await DB.clear('sessions');
        for(const w of d.workouts) await DB.put('workouts', w);
        for(const s of (d.sessions||[])) await DB.put('sessions', s);
        state.workouts = d.workouts; state.sessions = d.sessions||[];
        closeSheet(); renderAll(); toast('Backup importado');
      });
    }catch(err){ toast('Arquivo inválido'); }
    e.target.value='';
  };
  r.readAsText(file);
}
async function clearWorkouts(){
  await DB.clear('workouts');
  state.workouts=[]; closeSheet(); renderAll(); toast('Treinos excluídos');
}
async function resetAll(){
  await DB.clear('workouts'); await DB.clear('sessions');
  state.workouts=[]; state.sessions=[]; closeSheet(); renderAll(); toast('Tudo apagado');
}

/* ===================================================================
   FORMULÁRIOS (bottom sheet)
   =================================================================== */
function openSheet(html){
  const sh=$('sheet');
  sh.innerHTML = '<div class="sheet-grab" aria-hidden="true"></div>' + html;
  sh.style.transform=''; sh.scrollTop=0;
  $('overlay').classList.add('open');
}
function closeSheet(){ $('overlay').classList.remove('open'); $('sheet').style.transform=''; }
$('overlay').addEventListener('click', e=>{ if(e.target.id==='overlay') closeSheet(); });
/* deslizar a gaveta pra baixo pra fechar */
(function bindSheetSwipe(){
  const sh=$('sheet'); if(!sh) return;
  let y0=0, dy=0, on=false;
  sh.addEventListener('touchstart', e=>{ on = sh.scrollTop<=0; y0=e.touches[0].clientY; dy=0; sh.style.transition='none'; }, {passive:true});
  sh.addEventListener('touchmove', e=>{
    if(!on) return;
    dy = e.touches[0].clientY - y0;
    if(dy>0){ e.preventDefault(); sh.style.transform='translateY('+dy+'px)'; }
    else { on=false; sh.style.transform=''; }
  }, {passive:false});
  sh.addEventListener('touchend', ()=>{
    sh.style.transition='transform .2s ease';
    if(on && dy>110){ closeSheet(); } else { sh.style.transform=''; }
    on=false;
  });
})();

function showConfirm(title, msg, okLabel, onOk){
  openSheet(`<h2>${esc(title)}</h2><p class="small muted" style="margin:-8px 0 18px">${esc(msg)}</p>
    <div class="btn-stack">
      <button class="btn danger" id="cOk">${esc(okLabel)}</button>
      <button class="btn ghost" id="cNo">Voltar</button>
    </div>`);
  $('cOk').onclick = onOk;
  $('cNo').onclick = closeSheet;
}

function editWorkout(id){
  const w = id ? state.workouts.find(x=>x.id===id) : null;
  openSheet(`<h2>${w?'Renomear treino':'Novo treino'}</h2>
    <div class="field"><label>Nome do treino</label>
      <input id="wName" placeholder="Ex: Treino A — Peito" value="${w?esc(w.name):''}"></div>
    <div class="btn-stack"><button class="btn primary" id="saveW">Salvar</button></div>`);
  setTimeout(()=>$('wName').focus(), 100);
  $('saveW').onclick = async()=>{
    const name = $('wName').value.trim(); if(!name){ toast('Dê um nome'); return; }
    if(w){ w.name=name; await DB.put('workouts', JSON.parse(JSON.stringify(w))); }
    else{
      const nw = { id:uid(), name, order: state.workouts.length, exercises:[] };
      state.workouts.push(nw); await DB.put('workouts', nw);
      state.detailId = nw.id;
    }
    closeSheet();
    if(!w){ renderDetail(); show('detail'); } else { renderDetail(); }
    renderWorkouts();
    if(state.view==='detail') $('hdrTitle').textContent = curWorkout().name;
  };
}
function confirmDelWorkout(w){
  showConfirm('Excluir treino?', `“${w.name}” será removido. O histórico continua salvo.`, 'Excluir', async()=>{
    await DB.del('workouts', w.id);
    state.workouts = state.workouts.filter(x=>x.id!==w.id);
    closeSheet(); show('workouts'); renderWorkouts();
  });
}

function editExercise(wid, exid, groupId){
  const w = state.workouts.find(x=>x.id===wid);
  const ex = exid ? w.exercises.find(e=>e.id===exid) : null;
  const isTempo = ex ? ex.mode==='tempo' : false;
  const inSet = !!(groupId || (ex && ex.group));   // dentro de um Set? então séries/descanso vêm do Set
  openSheet(`<h2>${ex?'Editar exercício':'Novo exercício'}${inSet?' <span class="tiny muted">(no Set)</span>':''}</h2>
    <div class="field"><label>Nome</label>
      <input id="eName" placeholder="Ex: Supino reto" value="${ex?esc(ex.name):''}"></div>
    <div class="field"><label>Tipo</label>
      <div class="seg" id="eMode">
        <button type="button" data-m="reps" class="${isTempo?'':'on'}">Séries × reps</button>
        <button type="button" data-m="tempo" class="${isTempo?'on':''}">Tempo</button>
      </div></div>
    <div class="grid2">
      <div class="field" id="fSets"><label>Séries</label>
        <input id="eSets" type="number" inputmode="numeric" min="1" step="1" value="${ex?ex.sets:3}"></div>
      <div class="field" id="fReps"><label>Repetições</label>
        <input id="eReps" placeholder="8-12" value="${ex&&!isTempo?esc(ex.reps):'10-12'}"></div>
      <div class="field" id="fTime"><label>Tempo (min)</label>
        <input id="eTime" type="number" inputmode="numeric" min="0" step="1" placeholder="40" value="${ex&&isTempo?esc(ex.reps):''}"></div>
    </div>
    <div class="grid2">
      <div class="field" id="fWeight"><label>Peso (kg)</label>
        <input id="eWeight" type="number" inputmode="decimal" min="0" step="any" value="${ex?ex.weight:0}" onfocus="if(this.value==='0')this.value='';this.select()"></div>
      <div class="field" id="fRest"><label>Descanso (s)</label>
        <input id="eRest" type="number" inputmode="numeric" min="0" step="5" value="${ex?ex.rest:60}" onfocus="if(this.value==='0')this.value='';this.select()"></div>
    </div>
    <div class="field"><label>Observação (opcional)</label>
      <input id="eNotes" placeholder="Ex: pegada fechada" value="${ex?esc(ex.notes||''):''}"></div>
    <div class="btn-stack">
      <button class="btn primary" id="saveE">Salvar</button>
      ${ex?'<button class="btn danger" id="delE">Excluir exercício</button>':''}
    </div>`);
  let curMode = isTempo ? 'tempo' : 'reps';
  function applyMode(){
    const t = curMode==='tempo';
    $('fReps').hidden = t; $('fWeight').hidden = t; $('fTime').hidden = !t;
    if(inSet){ $('fSets').hidden = true; $('fRest').hidden = true; }  // Set controla séries/descanso
    $('eMode').querySelectorAll('button').forEach(b=>b.classList.toggle('on', b.dataset.m===curMode));
  }
  $('eMode').querySelectorAll('button').forEach(b=>{
    b.onclick = ()=>{ curMode = b.dataset.m; applyMode(); };
  });
  applyMode();
  setTimeout(()=>$('eName').focus(), 100);
  $('saveE').onclick = async()=>{
    const name=$('eName').value.trim(); if(!name){ toast('Dê um nome'); return; }
    const tempo = curMode==='tempo';
    const grp = groupId || (ex && ex.group) || null;
    const data = {
      name,
      mode: tempo ? 'tempo' : 'reps',
      sets: inSet ? 1 : Math.max(1, parseInt($('eSets').value)||1),
      reps: tempo ? (String(parseInt($('eTime').value)||0)) : ($('eReps').value.trim()||'-'),
      weight: tempo ? 0 : Math.max(0, parseFloat($('eWeight').value)||0),
      rest: inSet ? 0 : Math.max(0, parseInt($('eRest').value)||0),
      notes: $('eNotes').value.trim(),
      group: grp
    };
    if(ex) Object.assign(ex, data);
    else w.exercises.push({ id:uid(), ...data });
    await DB.put('workouts', JSON.parse(JSON.stringify(w)));
    closeSheet(); renderDetail();
  };
  if(ex) $('delE').onclick = async()=>{
    w.exercises = w.exercises.filter(e=>e.id!==exid);
    await DB.put('workouts', JSON.parse(JSON.stringify(w)));
    closeSheet(); renderDetail();
  };
}

/* criar / editar um Set (grupo de exercícios repetido em voltas) */
function editSet(wid, gid){
  const w = state.workouts.find(x=>x.id===wid);
  if(!w.groups) w.groups = [];
  const g = gid ? w.groups.find(x=>x.id===gid) : null;
  openSheet(`<h2>${g?'Editar Set':'Novo Set'}</h2>
    <p class="small muted" style="margin:-8px 0 16px">Faz os exercícios em sequência, descansa e repete.</p>
    <div class="field"><label>Nome (opcional)</label>
      <input id="gName" placeholder="Ex: Set A" value="${g?esc(g.name||''):''}"></div>
    <div class="grid2">
      <div class="field"><label>Voltas (vezes)</label>
        <input id="gRounds" type="number" inputmode="numeric" min="1" step="1" value="${g?g.rounds:3}"></div>
      <div class="field"><label>Descanso entre voltas (s)</label>
        <input id="gRest" type="number" inputmode="numeric" min="0" step="5" value="${g?g.rest:90}" onfocus="if(this.value==='0')this.value='';this.select()"></div>
    </div>
    <div class="btn-stack">
      <button class="btn primary" id="saveG">Salvar</button>
      ${g?'<button class="btn danger" id="delG">Excluir Set (e seus exercícios)</button>':''}
    </div>`);
  setTimeout(()=>$('gName').focus(), 100);
  $('saveG').onclick = async()=>{
    const data = {
      name: $('gName').value.trim(),
      rounds: Math.max(1, parseInt($('gRounds').value)||1),
      rest: Math.max(0, parseInt($('gRest').value)||0)
    };
    if(g){ Object.assign(g, data); }
    else { const ng = { id:uid(), ...data }; w.groups.push(ng); }
    await DB.put('workouts', JSON.parse(JSON.stringify(w)));
    closeSheet(); renderDetail();
    if(!g){ toast('Set criado — agora adicione exercícios nele'); }
  };
  if(g) $('delG').onclick = ()=>{
    showConfirm('Excluir Set?', 'O Set e os exercícios dentro dele serão removidos.', 'Excluir', async()=>{
      w.exercises = w.exercises.filter(e=>e.group!==gid);
      w.groups = w.groups.filter(x=>x.id!==gid);
      await DB.put('workouts', JSON.parse(JSON.stringify(w)));
      closeSheet(); renderDetail();
    });
  };
}

/* ===================================================================
   TEMA
   =================================================================== */
function applyTheme(mode){
  localStorage.setItem('theme', mode);
  const root=document.documentElement;
  if(mode==='auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  const meta=document.querySelector('meta[name="theme-color"]');
  const dark = mode==='dark' || (mode==='auto' && matchMedia('(prefers-color-scheme:dark)').matches);
  if(meta) meta.content = dark? '#535657':'#F4FAFF';
}

/* ===================================================================
   BOOT
   =================================================================== */
function renderAll(){ renderWorkouts(); renderHistory(); renderProgress(); renderSettings(); if(state.view==='detail') renderDetail(); }

/* ---------- Carregar dados do usuário logado ---------- */
async function loadData(){
  state.workouts = await DB.getAll('workouts');
  state.sessions = await DB.getAll('sessions');
  await loadDraft();
  let inited=null; try{ inited = await DB.get('meta','init'); }catch(e){}
  if(!inited && DB.live()){                // só semeia com o servidor alcançável (offline não duplica)
    if(!state.workouts.length){            // conta nova: cria o plano inicial uma única vez
      state.workouts = seed();
      for(const w of state.workouts) await DB.put('workouts', w);
    }
    try{ await DB.put('meta', {id:'init', done:true}); }catch(e){}  // marca como inicializada: não recria depois
  }
}

/* ---------- Telas de abertura (gate) ---------- */
function showGate(html){ $('gate').innerHTML = html; $('gate').hidden = false; $('app').hidden = true; document.documentElement.classList.add('on-gate'); }
function enterApp(){ $('gate').hidden = true; $('app').hidden = false; document.documentElement.classList.remove('on-gate'); requestAnimationFrame(()=>{ moveNavInd(); setTimeout(moveNavInd, 250); }); }

/* ---------- Tela de conexão com o servidor ---------- */
const DEFAULT_SERVER = 'https://homelab.tail69a525.ts.net:8447';
function showServerSetup(msg){
  let url = ''; try{ url = (JSON.parse(localStorage.getItem('treino.server')||'{}').url) || ''; }catch(e){}
  showGate(`
    <div class="logo"><i class="fa-solid fa-dumbbell"></i></div>
    <h1>Meu Treino</h1>
    <p class="sub">Conecte ao seu homeserver<br>(o Tailscale precisa estar ligado)</p>
    <form id="srvForm" novalidate>
      <div class="field"><label>Endereço do servidor</label>
        <input id="srvUrl" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(url||DEFAULT_SERVER)}" required></div>
      <div class="field"><label>Token</label>
        <input id="srvToken" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>
      <div class="msg err" id="srvMsg">${esc(msg||'')}</div>
      <button class="btn primary" type="submit" id="srvBtn">Conectar</button>
    </form>`);
  $('srvForm').onsubmit = async e=>{
    e.preventDefault();
    const u=$('srvUrl').value.trim(), t=$('srvToken').value.trim();
    if(!/^https?:\/\//i.test(u) || t.length<8){ $('srvMsg').textContent='Preencha o endereço (https://…) e o token.'; return; }
    $('srvBtn').disabled=true; $('srvBtn').textContent='Conectando…'; $('srvMsg').textContent='';
    DB.configure(u,t);
    try{ await DB.test(); await startApp(); }
    catch(err){
      DB.clearConfig();
      const bad = err && err.status===401;
      showServerSetup(bad ? 'Token incorreto.' : 'Não consegui falar com o servidor. Confira o endereço e se o Tailscale está ligado.');
    }
  };
  setTimeout(()=>{ const f=$('srvToken'); if(f) f.focus(); }, 120);
}

async function startApp(){
  showGate('<div class="spin">Carregando…</div>');
  try{ await loadData(); }
  catch(e){ console.error(e); toast('Erro ao carregar dados'); state.workouts=[]; state.sessions=[]; }
  renderAll();
  enterApp();
  show('workouts');
  DB.flush();
}

/* ---------- Handlers fixos da interface (ligados uma única vez) ---------- */
function bindStaticUI(){
  document.querySelectorAll('nav button').forEach(b=>{
    b.onclick = ()=>{ const t=b.dataset.tab;
      if(t==='workouts'){ renderWorkouts(); show('workouts'); }
      else if(t==='history'){ renderHistory(); show('history'); }
      else if(t==='progress'){ renderProgress(); show('progress'); }
      else { renderSettings(); show('settings'); }
    };
  });
  $('view-workouts').addEventListener('click', e=>{
    const c=e.target.closest('[data-open]'); if(c){ state.detailId=c.dataset.open; renderDetail(); show('detail'); }
  });
  $('view-history').addEventListener('click', e=>{
    const c=e.target.closest('[data-sess]'); if(c) openSession(c.dataset.sess);
  });
  $('backBtn').onclick = ()=>{
    if(state.view==='session'){ pauseSession(); }   // sai salvando como rascunho
    else { show('workouts'); renderWorkouts(); }
  };
  $('themeBtn').onclick = ()=>{
    const cur=localStorage.getItem('theme')||'auto';
    const next = cur==='dark'?'light':cur==='light'?'auto':'dark';
    applyTheme(next); toast('Tema: '+({auto:'automático',light:'claro',dark:'escuro'}[next]));
    const sel=$('themeSel'); if(sel) sel.value=next;
  };
  // controles do cronômetro de descanso
  $('restSkip').onclick  = ()=>stopRest();
  $('restMinus').onclick = ()=>{ if(restEnd && !restDone){ restEnd -= 15000; tickRest(); } };
  // ao voltar pro app, recalcula o tempo na hora (e avisa se já acabou enquanto fora)
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='visible' && restEnd){
      if(!restDone) requestWakeLock();   // reconquista o wake lock (o iOS solta ao sair)
      tickRest();
    }
  });
}

/* ---------- BOOT ---------- */
async function boot(){
  applyTheme(localStorage.getItem('theme')||'auto');
  bindStaticUI();
  if(!DB.configured()){ showServerSetup(); return; }
  await startApp();
}
boot();
