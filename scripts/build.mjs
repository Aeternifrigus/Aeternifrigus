// Builds _site/: copies index.html, renders writing/*.md, snapshots public repos.
import fs from 'node:fs/promises';
import { marked } from 'marked';

const cfg = JSON.parse(await fs.readFile('site.config.json', 'utf8'));
const OWNER = cfg.owner, TOKEN = process.env.GITHUB_TOKEN, OUT = '_site';

async function gh(p, soft) {
  const r = await fetch('https://api.github.com' + p, { headers: {
    Accept: 'application/vnd.github+json', 'User-Agent': 'site-build',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) } });
  if (r.status === 200) return r.json();
  if (soft) return null;
  throw new Error(`${p} -> ${r.status}`);   // fail the deploy rather than publish an empty list
}

async function repos() {
  const all = [];
  for (let page = 1; ; page++) {
    const b = await gh(`/users/${OWNER}/repos?type=owner&sort=pushed&per_page=100&page=${page}`);
    all.push(...b);
    if (b.length < 100) break;
  }
  const keep = all.filter(r => !r.private && !r.archived && (cfg.includeForks || !r.fork)
    && r.name.toLowerCase() !== OWNER.toLowerCase() && !cfg.exclude.includes(r.name));
  const one = async r => {
    const base = `/repos/${OWNER}/${r.name}`;
    const [langs, tree, act] = await Promise.all([
      gh(`${base}/languages`, true),
      gh(`${base}/git/trees/${r.default_branch}?recursive=1`, true),
      gh(`${base}/stats/commit_activity`, true)]);   // 202 while GitHub computes it: skipped
    const paths = (tree?.tree || []).filter(x => x.type === 'blob').map(x => x.path);
    const top = {};
    for (const p of paths) { const k = p.includes('/') ? p.split('/')[0] : './'; top[k] = (top[k] || 0) + 1; }
    const has = re => paths.some(p => re.test(p));
    return {
      name: r.name, description: r.description, url: r.html_url, topics: r.topics || [],
      site: r.has_pages ? `https://${OWNER.toLowerCase()}.github.io/${r.name}/` : (r.homepage || null),
      pages: !!r.has_pages, language: r.language, languages: langs || {}, stars: r.stargazers_count,
      pushed: r.pushed_at, files: paths.length,
      dirs: Object.entries(top).sort((a, b) => b[1] - a[1]),
      activity: Array.isArray(act) ? act.map(w => w.total) : null,
      flags: {
        tests: has(/(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*\.py$|\.(test|spec)\.[jt]sx?$/i),
        ci: has(/^\.github\/workflows\/|^\.gitlab-ci\.yml$/),
        docker: has(/(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i),
        iac: has(/\.tf$|(^|\/)(k8s|helm|terraform)\//i),
        docs: has(/^docs\//i) } };
  };
  const out = [];
  for (let i = 0; i < keep.length; i += 5) out.push(...await Promise.all(keep.slice(i, i + 5).map(one)));
  return out;
}

async function writing() {
  const files = (await fs.readdir('writing').catch(() => [])).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  const items = [];
  for (const f of files) {
    const raw = await fs.readFile(`writing/${f}`, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const meta = {};
    (m ? m[1] : '').split(/\r?\n/).forEach(l => { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    const body = (m ? m[2] : raw).trim();
    if (meta.draft === 'true') continue;
    const slug = f.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await fs.writeFile(`${OUT}/writing/${slug}.html`, marked.parse(body).replace(/(src=")(?!https?:|\/|data:)/g, '$1writing/'));
    items.push({ slug, title: meta.title || slug, date: meta.date || '', order: +meta.order || 0,
      summary: meta.summary || '', tags: meta.tags || '', medium: meta.medium || '', hasBody: body.length > 0 });
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);
  return items;
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(`${OUT}/data`, { recursive: true });
await fs.copyFile('index.html', `${OUT}/index.html`);
await fs.cp('writing', `${OUT}/writing`, { recursive: true, filter: s => !s.endsWith('.md') }).catch(() => {});
await fs.mkdir(`${OUT}/writing`, { recursive: true });
await fs.writeFile(`${OUT}/data/essays.json`, JSON.stringify(await writing()));
await fs.writeFile(`${OUT}/data/config.json`, JSON.stringify({ giscus: cfg.giscus?.repoId ? cfg.giscus : null }));
await fs.writeFile(`${OUT}/data/repos.json`, JSON.stringify(await repos()));
console.log('built', OUT);
