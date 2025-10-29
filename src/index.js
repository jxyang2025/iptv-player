/**
 * 简单测试 Worker - v4（带超时）
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (url.pathname === '/test-error') {
    try {
      console.log('👉 开始请求 http://10.255.255.1/');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

      await fetch('http://10.255.255.1/', {
        signal: controller.signal,
        method: 'GET',
        headers: { 'User-Agent': 'test-worker-v4' }
      });

      clearTimeout(timeoutId);
      return new Response('意外：请求居然成功了？', { status: 200 });
    } catch (err) {
      console.error('❌ 捕获异常:', err.message);
      return new Response(`[v4] 💥 捕获 fetch 错误: ${err.message}`, {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
  }

  if (url.pathname === '/test-500') {
    try {
      const resp = await fetch('https://httpbin.org/status/500');
      return new Response(`[v4] 🎯 上游返回 ${resp.status}`, {
        status: resp.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    } catch (err) {
      return new Response(`[v4] ❌ fetch 失败: ${err.message}`, { status: 500 });
    }
  }

  return new Response('[v4] 🚀 Hello from simple worker! (v4)', {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
