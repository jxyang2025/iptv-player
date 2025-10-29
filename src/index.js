/**
 * 简单测试 Worker - v1
 * 用于验证部署是否生效
 */

// 简单的 CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

async function handleRequest(request) {
  const url = new URL(request.url);

  // 处理 OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // 故意制造一个网络错误
  if (url.pathname === '/error') {
    try {
      await fetch('https://invalid-domain-123456789.example.com');
    } catch (err) {
      return new Response(`[v1] 代理失败: ${err.message}`, {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
  }

  // 正常响应
  return new Response('[v1] Hello from simple worker!', {
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
