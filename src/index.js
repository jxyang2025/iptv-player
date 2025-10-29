/**
 * 米谷视频 M3U 代理 Worker
 * 支持自动抓取 interface.txt 并代理加密流
 */

const GITHUB_RAW = 'https://raw.githubusercontent.com/develop202/migu_video/refs/heads/main/interface.txt';
const PROXY_PREFIX = 'https://m3u.521986.xyz/proxy';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Headers': '*'
};

// 模拟安卓设备请求
const FAKE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36',
  'Referer': 'https://m3u.521986.xyz/',
  'Origin': 'https://m3u.521986.xyz'
};

/**
 * 主请求处理
 */
async function handleRequest(request) {
  const url = new URL(request.url);

  // 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 路由分发
  if (url.pathname === '/' || url.pathname === '/playlist.m3u8') {
    return await generatePlaylist();
  }

  if (url.pathname === '/proxy') {
    return await handleProxy(request);
  }

  return new Response('Not Found', { status: 404 });
}

/**
 * 生成 M3U 播放列表
 */
async function generatePlaylist() {
  try {
    const response = await fetch(GITHUB_RAW);
    const text = await response.text();

    const lines = text.split('\n');
    let m3u = '#EXTM3U x-tvg-url="https://live.fanmingming.com/tvg/epg.xml"\n';

    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('#') || !line.includes('http')) continue;

      const match = line.match(/(CCTV-\d+.*?)\s+(https?:\/\/.*)/i);
      if (match) {
        const name = match[1].trim();
        const rawUrl = match[2].trim();

        // 构造代理 URL
        const proxyUrl = `${PROXY_PREFIX}?target=${encodeURIComponent(rawUrl)}`;

        m3u += `#EXTINF:-1 tvg-id="${name}" tvg-name="${name}" group-title="央视",${name}\n`;
        m3u += `${proxyUrl}\n`;
      }
    }

    return new Response(m3u, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/x-mpegurl; charset=utf-8',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (err) {
    return new Response(`#EXTM3U\n#EXTINF:-1,抓取失败: ${err.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * 代理真实 m3u8 和 ts 请求
 */
async function handleProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('target');

  if (!target) {
    return new Response('Missing "target" parameter', { status: 400 });
  }

  try {
    const upstreamUrl = new URL(target);
    const proxyRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: FAKE_HEADERS,
      redirect: 'follow'
    });

    const response = await fetch(proxyRequest);

    // 如果是 m3u8，可以继续重写内部的 ts 链接（可选）
    let body = response.body;
    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('audio/mpegurl') ||
        url.pathname.endsWith('.m3u8')) {

      const text = await response.text();
      body = rewriteM3u8Content(text, upstreamUrl.origin);
    }

    const modifiedResponse = new Response(body, response);
    Object.entries(corsHeaders).forEach(([k, v]) => {
      modifiedResponse.headers.set(k, v);
    });

    return modifiedResponse;

  } catch (err) {
    return new Response(`[Proxy Error] ${err.message}`, { status: 500 });
  }
}

/**
 * 可选：重写 m3u8 内部的 ts 链接，防止直连
 */
function rewriteM3u8Content(content, baseOrigin) {
  return content.replace(/(https?:\/\/[^\s"']+\.ts[^\s"']*)/g, (match) => {
    return `${PROXY_PREFIX}?target=${encodeURIComponent(match)}`;
  });
}

// 注册事件
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
