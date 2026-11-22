// Super admin Helm Ops (mobile/admin/index.html, servi sur GitHub Pages).
// Réservé aux e-mails listés dans le secret SUPER_ADMIN_EMAILS (séparés par des virgules) :
// sans ce secret, tout est refusé. Jamais de rôle en base (un rôle se modifie, un secret non).
// Ne lit JAMAIS le contenu métier des comptes (clients, prestas, factures) : uniquement
// auth.users, profiles, subscriptions et des dates de mise à jour (company_info.updated_at).
//
// GET  ?view=overview | accounts | account&id=<uid> | health
// POST { action: 'extend', id, days } | { action: 'suspend' | 'reactivate', id }
//   suspend = bannissement Supabase Auth (plus de connexion ni de rafraîchissement de session ;
//   un jeton déjà émis reste valable jusqu'à son expiration, 1 h maximum).

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MONTHLY_PRICE = 9.9; // MRR estimé au tarif actuel
const DAY = 86400000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Cache-Control': 'no-store',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

type Sb = ReturnType<typeof createClient>;

async function allAuthUsers(sb: Sb) {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}

async function buildAccounts(sb: Sb) {
  const [users, subs, ci] = await Promise.all([
    allAuthUsers(sb),
    sb.from('subscriptions').select('user_id, plan, period, status, expires_at, created_at, stripe_subscription_id').order('created_at', { ascending: false }),
    sb.from('company_info').select('user_id, updated_at'),
  ]);
  if (subs.error) throw subs.error;
  const lastSub: Record<string, any> = {};
  for (const s of subs.data || []) if (!lastSub[s.user_id]) lastSub[s.user_id] = s;
  const ciAt: Record<string, string> = {};
  for (const r of ci.data || []) ciAt[r.user_id] = r.updated_at;
  const now = Date.now();
  return users.map((u) => {
    const sub = lastSub[u.id] || null;
    const active = !!(sub?.expires_at && new Date(sub.expires_at).getTime() > now);
    const banned = !!(u.banned_until && new Date(u.banned_until).getTime() > now);
    const lastActive = [u.last_sign_in_at, ciAt[u.id]].filter(Boolean).sort().pop() || null;
    return {
      id: u.id, email: u.email, name: u.user_metadata?.full_name || '',
      provider: u.app_metadata?.provider || '', createdAt: u.created_at, lastSignIn: u.last_sign_in_at,
      lastActive, suspended: banned,
      sub: sub ? { plan: sub.plan, period: sub.period, status: sub.status, expiresAt: sub.expires_at, stripeId: sub.stripe_subscription_id } : null,
      active,
    };
  });
}

function overview(accounts: any[]) {
  const now = Date.now();
  const live = accounts.filter((a) => a.active && !['canceled', 'cancelled', 'past_due'].includes(a.sub.status));
  const paying = live.filter((a) => a.sub.period !== 'gift');
  const since = (d: number) => accounts.filter((a) => now - new Date(a.createdAt).getTime() < d * DAY).length;
  const activeIn = (d: number) => accounts.filter((a) => a.lastActive && now - new Date(a.lastActive).getTime() < d * DAY).length;
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const end = now - i * 7 * DAY, start = end - 7 * DAY;
    return { start: new Date(start).toISOString(), n: accounts.filter((a) => { const t = new Date(a.createdAt).getTime(); return t >= start && t < end; }).length };
  }).reverse();
  const watch: any[] = [];
  for (const a of accounts) {
    if (a.sub?.status === 'past_due') watch.push({ id: a.id, email: a.email, why: 'Paiement en échec' });
    else if (a.active && new Date(a.sub.expiresAt).getTime() - now < 7 * DAY && (a.sub.period === 'gift' || a.sub.status !== 'active')) watch.push({ id: a.id, email: a.email, why: 'Expire sous 7 jours' });
    else if (a.sub && !a.active && now - new Date(a.sub.expiresAt).getTime() < 30 * DAY) watch.push({ id: a.id, email: a.email, why: 'Abonnement expiré récemment' });
    else if (!a.sub && now - new Date(a.createdAt).getTime() < 30 * DAY) watch.push({ id: a.id, email: a.email, why: 'Inscrit sans abonnement' });
  }
  const mrr = paying.reduce((s, a) => s + (a.sub.period === 'yearly' ? MONTHLY_PRICE * 10 / 12 : MONTHLY_PRICE), 0);
  return {
    users: accounts.length, paying: paying.length, gifted: live.length - paying.length,
    pastDue: accounts.filter((a) => a.sub?.status === 'past_due').length,
    expired: accounts.filter((a) => a.sub && !a.active).length,
    noSub: accounts.filter((a) => !a.sub).length,
    suspended: accounts.filter((a) => a.suspended).length,
    mrr: Math.round(mrr * 100) / 100, arr: Math.round(mrr * 12),
    signups7: since(7), signups30: since(30), active7: activeIn(7), active30: activeIn(30),
    weeks, watch: watch.slice(0, 30),
  };
}

async function health(sb: Sb) {
  const env: Record<string, boolean> = {};
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPER_ADMIN_EMAILS', 'BREVO_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID_MONTHLY', 'APP_RELAY_SECRET', 'CRON_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'])
    env[k] = !!Deno.env.get(k);
  const checks: any[] = [];
  const t0 = Date.now();
  const { error: dbErr } = await sb.from('profiles').select('id', { head: true, count: 'exact' });
  checks.push({ name: 'Base Supabase', ok: !dbErr, detail: dbErr ? dbErr.message : `répond en ${Date.now() - t0} ms` });

  const brevo = Deno.env.get('BREVO_API_KEY');
  if (brevo) {
    try {
      const r = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': brevo, Accept: 'application/json' } });
      const j = await r.json();
      const credits = (j.plan || []).map((p: any) => `${p.type} : ${p.credits ?? '∞'} crédits`).join(' · ');
      checks.push({ name: 'E-mails Brevo', ok: r.ok, detail: r.ok ? credits || 'compte OK' : j.message || `HTTP ${r.status}` });
    } catch (e) { checks.push({ name: 'E-mails Brevo', ok: false, detail: String(e) }); }
  } else checks.push({ name: 'E-mails Brevo', ok: false, detail: 'BREVO_API_KEY absent' });

  const stripe = Deno.env.get('STRIPE_SECRET_KEY');
  if (stripe) {
    const sget = (p: string) => fetch('https://api.stripe.com/v1/' + p, { headers: { Authorization: `Bearer ${stripe}` } }).then((r) => r.json());
    try {
      const [hooks, bal] = await Promise.all([sget('webhook_endpoints?limit=20'), sget('balance')]);
      if (hooks.error) throw new Error(hooks.error.message);
      // Même compte Stripe que Bar Ops : on ne garde que le webhook qui pointe vers ce projet
      const mine = (hooks.data || []).filter((h: any) => String(h.url).includes('chlmqnrvnrgeaihryreb'));
      const hk = mine.map((h: any) => `${String(h.url).replace(/^https?:\/\//, '')} (${h.status})`).join(' · ') || 'aucun webhook Helm';
      checks.push({ name: 'Stripe', ok: mine.some((h: any) => h.status === 'enabled'), detail: `${stripe.startsWith('sk_live') ? 'mode réel' : 'mode test'} · ${hk}` });
      const eur = (a: any[]) => ((a || []).find((x) => x.currency === 'eur')?.amount || 0) / 100;
      checks.push({ name: 'Solde Stripe (compte partagé avec Bar Ops)', ok: true, detail: `disponible ${eur(bal.available)} € · en attente ${eur(bal.pending)} €` });
    } catch (e) { checks.push({ name: 'Stripe', ok: false, detail: String(e) }); }
  } else checks.push({ name: 'Stripe', ok: false, detail: 'STRIPE_SECRET_KEY absent' });

  const { data: ci } = await sb.from('company_info').select('updated_at').order('updated_at', { ascending: false }).limit(1);
  checks.push({ name: 'Dernière synchro cloud (Mon entreprise)', ok: true, detail: ci?.[0]?.updated_at || '—' });

  try {
    const r = await fetch('https://api.github.com/repos/SPECTRE888/Helm-Ops/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'helm-admin' } });
    const j = await r.json();
    checks.push({ name: 'Release Mac', ok: r.ok, detail: r.ok ? `${j.tag_name} · ${String(j.published_at || '').slice(0, 10)} · ${(j.assets || []).length} fichiers` : `HTTP ${r.status}` });
  } catch (e) { checks.push({ name: 'Release Mac', ok: false, detail: String(e) }); }
  return { env, checks };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  const allowed = (Deno.env.get('SUPER_ADMIN_EMAILS') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return json({ error: 'SUPER_ADMIN_EMAILS non configuré' }, 403);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'auth_required' }, 401);
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: ud, error: authErr } = await sb.auth.getUser(token);
  const user = ud?.user;
  if (authErr || !user) return json({ error: 'invalid_token' }, 401);
  if (!allowed.includes((user.email || '').toLowerCase())) return json({ error: 'forbidden' }, 403);

  try {
    const url = new URL(req.url);
    if (req.method === 'GET') {
      const view = url.searchParams.get('view') || 'overview';
      if (view === 'overview') return json(overview(await buildAccounts(sb)));
      if (view === 'accounts') return json(await buildAccounts(sb));
      if (view === 'account') {
        const id = url.searchParams.get('id') || '';
        const a = (await buildAccounts(sb)).find((x) => x.id === id);
        if (!a) return json({ error: 'Compte introuvable' }, 404);
        const { data: subs } = await sb.from('subscriptions').select('plan, period, status, expires_at, created_at, stripe_subscription_id').eq('user_id', id).order('created_at', { ascending: false }).limit(20);
        return json({ ...a, subs: subs || [] });
      }
      if (view === 'health') return json(await health(sb));
      return json({ error: 'Vue inconnue' }, 400);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const { action, id } = body || {};
      if (!id || typeof id !== 'string') return json({ error: 'id manquant' }, 400);
      const { data: tu, error: tuErr } = await sb.auth.admin.getUserById(id);
      if (tuErr || !tu?.user) return json({ error: 'Compte introuvable' }, 404);

      if (action === 'extend') {
        const days = Math.round(Number(body.days));
        if (!(days >= 1 && days <= 730)) return json({ error: 'Durée invalide (1 à 730 jours)' }, 400);
        const { data: sub } = await sb.from('subscriptions').select('id, expires_at').eq('user_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        const base = Math.max(Date.now(), sub?.expires_at ? new Date(sub.expires_at).getTime() : 0);
        const expiresAt = new Date(base + days * DAY).toISOString();
        // Pas de ligne : accès offert (period 'gift', aucun lien Stripe)
        const { error } = sub
          ? await sb.from('subscriptions').update({ expires_at: expiresAt, status: 'active', updated_at: new Date().toISOString() }).eq('id', sub.id)
          : await sb.from('subscriptions').insert([{ user_id: id, plan: 'standard', period: 'gift', status: 'active', expires_at: expiresAt }]);
        if (error) throw error;
        console.log('superadmin_extend', JSON.stringify({ by: user.email, id, days, expiresAt }));
        return json({ ok: true, expiresAt });
      }
      if (action === 'suspend' || action === 'reactivate') {
        if (action === 'suspend' && id === user.id) return json({ error: 'Impossible de suspendre votre propre compte' }, 400);
        const { error } = await sb.auth.admin.updateUserById(id, { ban_duration: action === 'suspend' ? '876000h' : 'none' } as any);
        if (error) throw error;
        console.log('superadmin_' + action, JSON.stringify({ by: user.email, id }));
        return json({ ok: true, suspended: action === 'suspend' });
      }
      return json({ error: 'Action inconnue' }, 400);
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('admin error:', e);
    return json({ error: (e as Error).message || 'Erreur serveur' }, 500);
  }
});
