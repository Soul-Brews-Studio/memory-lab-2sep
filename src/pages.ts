import { escapeHtml } from "./utils";
import { VERSION } from "./version";

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Bai Jamjuree","Noto Sans Thai",sans-serif;background:#0b0d14;color:#e6e9f2}
main{max-width:64rem;margin:0 auto;padding:2rem 1.25rem}
h1{font-size:1.4rem;margin:.2rem 0 .2rem}h2{font-size:1.05rem;margin:1.6rem 0 .5rem;color:#9fb0d8}
p{color:#aab3c9}code{background:#161a26;padding:.1rem .35rem;border-radius:.3rem;overflow-wrap:anywhere}
.card{background:#12151f;border:1px solid #262c3d;border-radius:14px;padding:1.25rem;margin:1rem 0}
label{display:grid;gap:.4rem;margin:1rem 0}
input,button{font:inherit;padding:.65rem .9rem;border-radius:9px;border:1px solid #3a4257;background:#0d1019;color:#fff}
button{background:#8fffd4;color:#07120e;font-weight:700;border:0;cursor:pointer}
button.ghost{background:transparent;color:#8fffd4;border:1px solid #2d6b56}
table{width:100%;border-collapse:collapse;font-size:.86rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #222839;vertical-align:top}
th{color:#8f9ab8;font-weight:600}
.err{color:#ff8c8c}.ok{color:#8fffd4}.muted{color:#6f7a95}
.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
.pill{display:inline-block;padding:.1rem .5rem;border-radius:99px;background:#1b2130;color:#b9c5e6;font-size:.8rem}
.pill.on{background:#12402f;color:#8fffd4}
.wrap{overflow-x:auto}
`;

export function approvalPage(input: {
  instanceName: string;
  clientName: string;
  claudeAi: boolean;
  error?: string;
  params: Record<string, string>;
}): string {
  const hidden = Object.entries(input.params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect ${escapeHtml(input.instanceName)}</title><style>${CSS}</style></head><body><main>
<div class="card" style="max-width:32rem;margin:3rem auto">
<p class="muted">${escapeHtml(input.instanceName)} · OAuth</p>
<h1>Connect ${escapeHtml(input.clientName)}${input.claudeAi ? ' <span class="pill on">claude.ai</span>' : ""}</h1>
<p>อนุญาตให้ client นี้ใช้ความจำ · This grants the client the <code>memory:rw</code> tools. The passphrase stays with this Worker; the client receives a revocable OAuth token, not the passphrase.</p>
${input.error ? `<p class="err">${escapeHtml(input.error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label>Owner passphrase · รหัสผ่านเจ้าของ<input name="passphrase" type="password" required autocomplete="current-password" autofocus></label>
<button type="submit">Authorize · อนุญาต</button></form>
<p class="muted">Redirect: <code>${escapeHtml(input.params.redirect_uri ?? "")}</code></p>
</div></main></body></html>`;
}

/** The dashboard: one static page; every number comes from GET /api/overview after login. No stream, no polling — Refresh is the live view. */
export function dashboardPage(instanceName: string): string {
  const name = escapeHtml(instanceName);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${name}</title><style>${CSS}</style></head><body><main>
<p class="muted">memory-lab-2sep ${VERSION} · Cloudflare Workers + D1 · stateless</p>
<h1>${name}</h1>
<p>ความจำหนึ่งเจ้าของบน Cloudflare · one owner's memory over MCP. <span id="who" class="pill">not signed in</span></p>
<div class="card" id="login"><form id="loginForm" class="row"><label style="flex:1;margin:0">Owner passphrase<input id="pass" type="password" autocomplete="current-password" required></label><button type="submit" style="align-self:end">Sign in</button></form><p id="loginErr" class="err"></p></div>
<div id="app" hidden>
<div class="row"><button id="refresh">Refresh</button><button class="ghost" id="logout">Sign out</button><span id="stamp" class="muted"></span></div>
<h2>Install · ติดตั้ง</h2>
<div class="card"><p>claude.ai → Settings → Connectors → Add custom connector → URL <code id="mcpUrl"></code> → Connect → enter the owner passphrase.</p>
<p>Claude Code (OAuth): <code id="ccOauth"></code></p><p>Claude Code (static token): <code id="ccToken"></code></p></div>
<h2>Status</h2><div class="card" id="status"></div>
<h2>Clients · ใครเชื่อมต่อ (24h)</h2><div class="card wrap"><table id="clients"></table></div>
<h2>Method calls · เมธอดที่ถูกเรียก จากไหน (newest 50)</h2><div class="card wrap"><table id="calls"></table></div>
<h2>OAuth access · สิทธิ์ที่ออกให้</h2><div class="card wrap"><table id="access"></table></div>
<h2>Memories · ความจำ (newest 20)</h2><div class="card wrap"><table id="memories"></table></div>
</div>
<script>
const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const origin=location.origin;$('#mcpUrl').textContent=origin+'/mcp';
$('#ccOauth').textContent='claude mcp add --transport http memory-lab '+origin+'/mcp && claude mcp login memory-lab';
$('#ccToken').textContent='claude mcp add --transport http memory-lab '+origin+'/mcp --header "Authorization: Bearer <API_TOKEN>"';
function table(el,cols,rows){el.innerHTML='<tr>'+cols.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr>'+(rows.length?rows.map(r=>'<tr>'+cols.map(c=>'<td>'+esc(typeof c[1]==='function'?c[1](r):r[c[1]])+'</td>').join('')+'</tr>').join(''):'<tr><td class="muted" colspan="'+cols.length+'">none</td></tr>')}
async function load(){const r=await fetch('/api/overview');if(r.status===401){show(false);return}const d=await r.json();show(true);
$('#who').textContent='signed in as owner';$('#who').className='pill on';$('#stamp').textContent='as of '+new Date().toISOString().slice(11,19)+' UTC';
const s=d.summary;$('#status').innerHTML='<div class="row"><span class="pill">memories '+esc(d.stats.memories)+'</span><span class="pill">clients 24h '+esc(s.total24h)+'</span><span class="pill">calls 24h '+esc(s.calls24h)+'</span><span class="pill '+(s.claudeAi==='connected'?'on':'')+'">claude.ai: '+esc(s.claudeAi)+'</span></div><p>doors: '+esc(Object.entries(s.byMethod).map(([k,v])=>k+' '+v).join(', ')||'none')+'</p><p>methods: '+esc(s.methods24h.map(m=>m.method+(m.tool?' '+m.tool:'')+' ×'+m.n).join(', ')||'none')+'</p><p>from: '+esc(s.countries24h.map(c=>(c.country||'?')+' ×'+c.n).join(', ')||'none')+'</p>';
table($('#clients'),[['client','label'],['door','method'],['req','requests'],['tools','toolCalls'],['clientInfo',r=>(r.clientName||'')+(r.clientVersion?' '+r.clientVersion:'')],['proto','protocolVersion'],['from',r=>(r.lastCountry||'?')+(r.lastColo?'/'+r.lastColo:'')+(r.lastIp?' '+r.lastIp:'')],['last tool','lastTool'],['last seen',r=>r.lastSeen.slice(0,19).replace('T',' ')],['user-agent',r=>(r.userAgent||'').slice(0,60)]],d.clients);
table($('#calls'),[['time',r=>r.ts.slice(5,19).replace('T',' ')],['method','rpcMethod'],['tool','tool'],['client','clientId'],['from',r=>(r.country||'?')+(r.city?' '+r.city:'')+(r.colo?' /'+r.colo:'')],['ip','ip'],['asn','asnOrg'],['ms','durationMs'],['ok',r=>r.ok?'✓':'✗ '+(r.error||'')]],d.calls);
table($('#access'),[['client','clientName'],['id','clientId'],['claude.ai',r=>r.claudeAi?'yes':''],['live tokens','activeTokens'],['last token','lastTokenAt'],['registered','createdAt'],['',r=>'']],d.access);
document.querySelectorAll('#access tr').forEach((tr,i)=>{if(i===0)return;const row=d.access[i-1];const td=tr.lastElementChild;const b=document.createElement('button');b.className='ghost';b.textContent='revoke';b.onclick=async()=>{if(!confirm('Revoke every token of '+(row.clientName||row.clientId)+'?'))return;await fetch('/api/access/clients/'+encodeURIComponent(row.clientId),{method:'DELETE'});load()};td.appendChild(b)});
table($('#memories'),[['id','id'],['title','title'],['content',r=>r.content.slice(0,120)],['tags',r=>r.tags.join(' ')],['by','createdBy'],['at',r=>r.createdAt.slice(0,16).replace('T',' ')]],d.memories);}
function show(on){$('#app').hidden=!on;$('#login').hidden=on}
$('#loginForm').onsubmit=async e=>{e.preventDefault();$('#loginErr').textContent='';const r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:$('#pass').value})});if(!r.ok){$('#loginErr').textContent='Wrong passphrase · รหัสผ่านไม่ตรง';return}$('#pass').value='';load()};
$('#refresh').onclick=load;$('#logout').onclick=async()=>{await fetch('/api/session',{method:'DELETE'});$('#who').textContent='not signed in';$('#who').className='pill';show(false)};
load();
</script></main></body></html>`;
}
