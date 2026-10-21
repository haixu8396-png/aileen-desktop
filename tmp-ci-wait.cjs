// 等 CI 跑完并检查发布结果（v0.7.5）
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
async function api(path) {
  const res = await fetch('https://api.github.com' + path, {
    headers: { Authorization: 'Bearer ' + T, Accept: 'application/vnd.github+json', 'User-Agent': 'aileen-release-check' },
  });
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const RUN = 39661640385;
  const deadline = Date.now() + 14 * 60 * 1000;
  let run = null;
  while (Date.now() < deadline) {
    run = await api('/repos/haixu8396-png/aileen-desktop/actions/runs/' + RUN);
    console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + run.status + '/' + (run.conclusion || '-'));
    if (run.status === 'completed') break;
    await sleep(20000);
  }
  if (!run || run.status !== 'completed') { console.log('STILL_RUNNING'); process.exit(2); }
  console.log('CONCLUSION=' + run.conclusion);

  // 失败的注解（CI 用 ::error 写，登录 Actions 日志看不到，但 API 能读）
  if (run.conclusion !== 'success') {
    const jobs = await api('/repos/haixu8396-png/aileen-desktop/actions/runs/' + RUN + '/jobs');
    for (const j of jobs.jobs || []) {
      console.log('JOB ' + j.name + ' -> ' + j.conclusion);
      for (const s of j.steps || []) console.log('   step ' + s.number + ' ' + s.name + ' : ' + s.conclusion);
    }
    const ann = await api('/repos/haixu8396-png/aileen-desktop/actions/runs/' + RUN + '/annotations').catch(() => []);
    for (const a of ann) console.log('ANNOTATION[' + a.annotation_level + '] ' + a.title + ' :: ' + a.message);
    process.exit(1);
  }

  const rel = await api('/repos/haixu8396-png/aileen-desktop/releases/tags/v0.7.5');
  console.log('RELEASE ' + rel.html_url + ' draft=' + rel.draft + ' prerelease=' + rel.prerelease);
  for (const a of rel.assets || []) console.log('  asset ' + a.name + '  ' + Math.round(a.size / 1024 / 1024 * 10) / 10 + ' MB');
})().catch((err) => { console.log('ERR ' + err.message); process.exit(1); });
