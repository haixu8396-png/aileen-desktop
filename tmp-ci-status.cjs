// 轮询 GitHub Actions：等 v0.7.5 的构建跑完
const { execSync } = require('child_process');

function token() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    cwd: __dirname,
  }).toString();
  const line = out.split('\n').find((l) => l.startsWith('password='));
  return line ? line.slice('password='.length).trim() : '';
}

const T = token();
if (!T) { console.log('no token'); process.exit(1); }

async function api(path) {
  const res = await fetch('https://api.github.com' + path, {
    headers: {
      Authorization: 'Bearer ' + T,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'aileen-release-check',
    },
  });
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

(async () => {
  const runs = await api('/repos/haixu8396-png/aileen-desktop/actions/runs?per_page=5');
  for (const r of runs.workflow_runs) {
    console.log(`run ${r.id} | ${r.event} | ${r.head_branch} | ${r.status}/${r.conclusion || '-'} | ${r.created_at}`);
  }
  const target = runs.workflow_runs.find((r) => r.head_branch === 'v0.7.5' || (r.head_sha || '').startsWith('f413c7c'));
  if (target) console.log('TARGET=' + target.id + ' ' + target.status + '/' + (target.conclusion || '-') + ' ' + target.html_url);
})().catch((err) => { console.log('ERR ' + err.message); process.exit(1); });
