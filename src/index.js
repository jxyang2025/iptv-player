/**
 * 简单测试 Worker - v2（修复版）
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
      // 使用一个能解析但连接失败的 IP
      await fetch('http://10.255.255.1/', { timeout: 5000 });
    } catch (err) {
      return new Response(`[v2] 代理失败: ${err.message}`, {
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
      return new Response(`上游返回 ${resp.status}`, {
        status: resp.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/plain'
        }
      });
    } catch (err) {
      return new Response(`[v2] fetch 失败: ${err.message}`, { status: 500 });
    }
  }

  return new Response('[v2] Hello from simple worker!', {
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
