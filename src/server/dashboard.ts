/**
 * Monitoring Dashboard
 *
 * GET /dashboard — HTML page with auto-refresh
 * GET /api/status — JSON status of all components
 */

import type { Request, Response } from "express";
import { config } from "../config.js";
import { sessionManager } from "../session/manager.js";
import { verifyClaude } from "../subprocess/manager.js";
import { statsCollector } from "./stats.js";

type ComponentStatus = "ok" | "degraded" | "down";

interface ComponentInfo {
  status: ComponentStatus;
  [key: string]: unknown;
}

// Cache Claude CLI check for 30 seconds
let cliCache: { result: { ok: boolean; version?: string }; ts: number } | null = null;
const CLI_CACHE_TTL = 30_000;

async function checkClaude(): Promise<{ ok: boolean; version?: string }> {
  if (cliCache && Date.now() - cliCache.ts < CLI_CACHE_TTL) return cliCache.result;
  const result = await verifyClaude();
  cliCache = { result, ts: Date.now() };
  return result;
}

async function checkHealth(url: string, timeoutMs = 3000): Promise<{ ok: boolean; status?: number; latencyMs?: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/**
 * GET /api/status
 */
export async function handleStatusApi(_req: Request, res: Response): Promise<void> {
  const stats = statsCollector.getStats();

  const [litellm, openclaw, cli] = await Promise.allSettled([
    checkHealth(`${config.litellmBaseUrl}/health`),
    checkHealth(`${config.openclawBaseUrl}/health`),
    checkClaude(),
  ]);

  const litellmResult = litellm.status === "fulfilled" ? litellm.value : { ok: false };
  const openclawResult = openclaw.status === "fulfilled" ? openclaw.value : { ok: false };
  const cliResult = cli.status === "fulfilled" ? cli.value : { ok: false };

  const components: Record<string, ComponentInfo> = {
    proxy: { status: "ok", port: 3456, requests: stats.totalRequests },
    litellm: {
      status: litellmResult.ok ? "ok" : "down",
      url: config.litellmBaseUrl,
      latency_ms: (litellmResult as { latencyMs?: number }).latencyMs ?? null,
    },
    openclaw: {
      status: openclawResult.ok ? "ok" : (openclawResult as { status?: number }).status ? "degraded" : "down",
      url: config.openclawBaseUrl,
    },
    claude_cli: {
      status: cliResult.ok ? "ok" : "down",
      version: cliResult.version ?? null,
    },
  };

  const now = Date.now();
  const sessions = sessionManager.getAll();
  const totalMessages = sessions.reduce((sum, s) => sum + (s.messageCount || 0), 0);

  res.json({
    uptime_seconds: stats.uptimeSeconds,
    uptime_human: stats.uptimeHuman,
    components,
    routing: {
      total: stats.totalRequests,
      claude: stats.claudeRequests,
      gemini: stats.geminiRequests,
      router_errors: stats.routerErrors,
      router_fallbacks: stats.routerFallbacks,
    },
    sessions: {
      active: sessions.length,
      total_messages: totalMessages,
      details: sessions.map((s) => ({
        id: s.claudeSessionId.slice(0, 8),
        model: s.model,
        messageCount: s.messageCount || 0,
        lastActive: formatAge(now - s.lastUsedAt),
        age: formatAge(now - s.createdAt),
      })),
    },
  });
}

/**
 * GET /dashboard
 */
export function handleDashboard(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Max API Proxy Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#121620;color:#e0e0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;max-width:960px;margin:0 auto}
h1{font-size:20px;font-weight:600;margin-bottom:4px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #2a3050}
.uptime{color:#8c96b0;font-size:13px;font-family:monospace}
.refresh{color:#6a7490;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.card{background:#1c2236;border:1px solid #374060;border-radius:10px;padding:16px;min-height:100px}
.card-title{font-size:13px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}
.dot-ok{background:#3fb950}
.dot-degraded{background:#d29922}
.dot-down{background:#f85149}
.card-port{color:#dcb05c;font-size:12px;font-family:monospace;margin-bottom:4px}
.card-detail{color:#8c96b0;font-size:12px;line-height:1.6}
.panel{background:#1c2236;border:1px solid #374060;border-radius:10px;padding:16px;margin-bottom:16px}
.panel-title{font-size:14px;font-weight:600;margin-bottom:10px}
.routing-bar{display:flex;height:24px;border-radius:6px;overflow:hidden;margin-bottom:8px;background:#121620}
.bar-claude{background:#8c64dc;transition:width .5s}
.bar-gemini{background:#28b48c;transition:width .5s}
.routing-legend{display:flex;gap:20px;font-size:12px;color:#8c96b0}
.routing-legend span{display:flex;align-items:center;gap:6px}
.legend-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#6a7490;font-weight:500;padding:6px 8px;border-bottom:1px solid #2a3050}
td{padding:6px 8px;color:#b0b8d0;border-bottom:1px solid #1e2640}
.empty{color:#6a7490;text-align:center;padding:20px;font-size:13px}
.err{color:#f85149}
</style>
</head>
<body>
<div class="header">
  <div><h1>Claude Max API Proxy</h1><div class="uptime" id="uptime">Loading...</div></div>
  <div class="refresh" id="refresh">Auto-refresh: 5s</div>
</div>

<div class="cards">
  <div class="card" id="c-proxy">
    <div class="card-title"><span class="dot" id="d-proxy"></span>Proxy</div>
    <div class="card-port">:3456</div>
    <div class="card-detail" id="t-proxy">—</div>
  </div>
  <div class="card" id="c-litellm">
    <div class="card-title"><span class="dot" id="d-litellm"></span>LiteLLM</div>
    <div class="card-port">:4000</div>
    <div class="card-detail" id="t-litellm">—</div>
  </div>
  <div class="card" id="c-openclaw">
    <div class="card-title"><span class="dot" id="d-openclaw"></span>OpenClaw</div>
    <div class="card-port">:18789</div>
    <div class="card-detail" id="t-openclaw">—</div>
  </div>
  <div class="card" id="c-cli">
    <div class="card-title"><span class="dot" id="d-cli"></span>Claude CLI</div>
    <div class="card-port">&nbsp;</div>
    <div class="card-detail" id="t-cli">—</div>
  </div>
</div>

<div class="panel">
  <div class="panel-title">Routing Statistics</div>
  <div class="routing-bar"><div class="bar-claude" id="bar-claude"></div><div class="bar-gemini" id="bar-gemini"></div></div>
  <div class="routing-legend">
    <span><span class="legend-dot" style="background:#8c64dc"></span> Claude: <b id="r-claude">0</b></span>
    <span><span class="legend-dot" style="background:#28b48c"></span> Gemini: <b id="r-gemini">0</b></span>
    <span>Total: <b id="r-total">0</b></span>
    <span>Errors: <b id="r-errors">0</b></span>
    <span>Fallbacks: <b id="r-fallbacks">0</b></span>
  </div>
</div>

<div class="panel">
  <div class="panel-title">Sessions (<span id="s-count">0</span> active) &nbsp; Total messages: <span id="s-msgs">0</span></div>
  <table>
    <thead><tr><th>ID</th><th>Model</th><th>Messages</th><th>Last Active</th><th>Age</th></tr></thead>
    <tbody id="s-body"><tr><td colspan="5" class="empty">No active sessions</td></tr></tbody>
  </table>
</div>

<script>
function dot(id,status){
  const el=document.getElementById('d-'+id);
  el.className='dot dot-'+status;
}
async function refresh(){
  const r=document.getElementById('refresh');
  try{
    r.textContent='Refreshing...';
    const res=await fetch('/api/status');
    const d=await res.json();
    document.getElementById('uptime').textContent='Uptime: '+d.uptime_human;

    const c=d.components;
    dot('proxy',c.proxy.status);
    document.getElementById('t-proxy').textContent=c.proxy.requests+' requests';
    dot('litellm',c.litellm.status);
    document.getElementById('t-litellm').textContent=c.litellm.status==='ok'?'Healthy'+(c.litellm.latency_ms!=null?' ('+c.litellm.latency_ms+'ms)':''):'Down';
    dot('openclaw',c.openclaw.status);
    document.getElementById('t-openclaw').textContent=c.openclaw.status==='ok'?'Healthy':c.openclaw.status==='degraded'?'Reachable':'Down';
    dot('cli',c.claude_cli.status);
    document.getElementById('t-cli').textContent=c.claude_cli.status==='ok'?(c.claude_cli.version||'Available'):'Unavailable';

    const rt=d.routing;
    document.getElementById('r-total').textContent=rt.total;
    document.getElementById('r-claude').textContent=rt.claude;
    document.getElementById('r-gemini').textContent=rt.gemini;
    document.getElementById('r-errors').textContent=rt.router_errors;
    document.getElementById('r-fallbacks').textContent=rt.router_fallbacks;
    const pct=rt.total>0?Math.round(rt.claude/rt.total*100):50;
    document.getElementById('bar-claude').style.width=pct+'%';
    document.getElementById('bar-gemini').style.width=(100-pct)+'%';

    document.getElementById('s-count').textContent=d.sessions.active;
    document.getElementById('s-msgs').textContent=d.sessions.total_messages;
    const tbody=document.getElementById('s-body');
    if(d.sessions.details.length===0){
      tbody.innerHTML='<tr><td colspan="5" class="empty">No active sessions</td></tr>';
    }else{
      tbody.innerHTML=d.sessions.details.map(s=>
        '<tr><td>'+s.id+'</td><td>'+s.model+'</td><td>'+s.messageCount+'</td><td>'+s.lastActive+'</td><td>'+s.age+'</td></tr>'
      ).join('');
    }
    r.textContent='Auto-refresh: 5s';
  }catch(e){
    r.innerHTML='<span class="err">Connection lost</span>';
  }
}
refresh();
setInterval(refresh,5000);
</script>
</body>
</html>`;
