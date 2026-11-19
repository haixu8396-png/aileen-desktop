// ============================================================
// 联网（R6）渲染层封装
//
// 原则（任务书 7）：
//   · 不新增第三方搜索 API、不要额外搜索 Key；
//   · 有原生能力就显示「支持」，没有就明确说「不支持」，绝不静默回退；
//   · 抓到的网页内容永远是不可信数据（这里只做搬运，不解释成指令）。
// ============================================================

function api() {
  return (typeof window !== 'undefined' && window.api) ? window.api : {};
}

/** 抓一个网页（主进程做 SSRF 防护与体积限制） */
export async function fetchPage(url) {
  const fn = api().webFetch;
  if (typeof fn !== 'function') throw new Error('当前版本没有网页抓取能力');
  return fn({ url: String(url || '').trim() });
}

/** 读当前 provider 的联网能力（未探测 = unknown） */
export async function readCapabilities() {
  const fn = api().webCapabilities;
  if (typeof fn !== 'function') return null;
  try { return await fn(); } catch { return null; }
}

/** 真探针：发一次最小请求，按响应判定能力 */
export async function probeCapabilities() {
  const fn = api().webProbe;
  if (typeof fn !== 'function') throw new Error('当前版本没有能力探针');
  return fn();
}

/**
 * 把能力对象压成一句人话（界面用）。
 * 三种状态都必须显示，不允许「大概能用」这种模糊说法。
 */
export function capabilitySummary(cap) {
  if (!cap || !cap.capabilities) return { status: 'unknown', text: '未知（还没检测）', docs: '' };
  const s = cap.capabilities.nativeWebSearch;
  const label = s === 'supported' ? '支持' : (s === 'unsupported' ? '不支持' : '未知');
  const docs = (cap.evidence && cap.evidence.sourceUrl) || '';
  const why = (cap.evidence && cap.evidence.reason) || '';
  return {
    status: s === 'supported' ? 'supported' : (s === 'unsupported' ? 'unsupported' : 'unknown'),
    text: '模型原生联网：' + label + (why ? '（' + why + '）' : ''),
    docs,
    checkedAt: (cap.evidence && cap.evidence.checkedAt) || null,
  };
}

/**
 * 为「人设生成 / 知识库」收集资料。
 *
 * 现状（0.7.9）：AILEEN 只有一条 OpenAI 兼容的 chat/completions 通路，
 * 原生搜索工具尚未接入 —— 所以这里**不假装能搜**：返回空列表并带原因，
 * 调用方会把字段标成 unknown（任务书 5.2「资料不足标注 unknown，不得编造」）。
 *
 * 用户自己给了 URL 时，才是真的能抓到东西。
 */
export async function collectSources({ urls = [], query = '' } = {}) {
  const out = [];
  const errors = [];
  for (const raw of (Array.isArray(urls) ? urls : []).slice(0, 5)) {
    const url = String(raw || '').trim();
    if (!url) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const page = await fetchPage(url);
      out.push({
        title: page.title || page.finalUrl || url,
        url: page.finalUrl || url,
        type: 'secondary',
        snippet: String(page.text || '').slice(0, 600),
        retrievedAt: page.fetchedAt,
      });
    } catch (err) {
      errors.push({ url, error: String((err && err.message) || err) });
    }
  }
  return {
    sources: out,
    errors,
    note: out.length ? '' : (query ? '没有可用的联网资料（当前模型不具备原生联网能力，或没有提供来源 URL）' : ''),
  };
}
