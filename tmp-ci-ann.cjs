// 取失败构建的注解 / 日志尾部
const { execSync } = require('child_process');
function token() {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', cwd: __dirname }).toString();
  const line = out.split('\n').find((l) => l.startsWith('password='));
  return line ? line.slice('password='.length).trim() : '';
}
const T = token();
async function api(path) {
  const res = await fetch('https://api.github.com' + path, {
    headers: { Authorization: 'Bearer ' + T, Accept: 'application/vnd.github+json', 'User-Agent': 'aileen-release-check' },
  });
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}
(async () => {
  const jobs = await api('/repos/haixu8396-png/aileen-desktop/actions/runs/39661640385/jobs');
  for (const j of jobs.jobs || []) {
    console.log('JOB', j.id, j.name, j.conclusion);
    try {
      const ann = await api('/repos/haixu8396-png/aileen-desktop/check-runs/' + j.id + '/annotations');
      for (const a of ann || []) console.log('  ANNOTATION[' + a.annotation_level + '] ' + a.path + ' :: ' + a.title + ' :: ' + a.message);
    } catch (err) { console.log('  (annotations err ' + err.message.slice(0, 120) + ')'); }
    const steps = (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
    console.log('  failed steps:', steps.join(' / ') || '-');
  }
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
