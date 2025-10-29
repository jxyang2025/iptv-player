/**
 * M3U/CORS 代理服务 - 支持相对路径的最终版
 */

// CORS 允许的头部
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

// 模拟设备的 User-Agent
const FAKE_UA = 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36';

/**
 * Base64 解码函数（安全版）
 */
function safeDecode(str) {
  try {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return atob(str);
  } catch (e) {
    throw new Error('Base64 解码失败: ' + e.message);
  }
}

/**
 * 主处理函数
 */
async function handleRequest(request) {
  const url = new URL(request.url);

  // === 1. 处理 OPTIONS 预检请求 ===
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // === 2. 解析目标 URL ===
  let targetUrl = null;

  // 模式 1: ?url= 参数代理（向后兼容）
  const urlParam = url.searchParams.get('url');
  if (urlParam) {
    try {
      targetUrl = new URL(decodeURIComponent(urlParam)).href;
    } catch (err) {
      return new Response('错误: 无效的 URL 格式 (url 参数)', {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }

  // 模式 2: Base64 路径代理 /p/...
  if (!targetUrl) {
    const pathParts = url.pathname.split('/');
    
    if (pathParts[1] === 'p' && pathParts[2]) {
      const encodedTarget = pathParts[2];
      
      // 检查是否是 Base64 编码
      if (encodedTarget.length >= 4 && encodedTarget.match(/^[A-Za-z0-9+/]*={0,2}$/)) {
        // Base64 编码的完整 URL
        try {
          const decodedUrl = safeDecode(encodedTarget);
          targetUrl = decodeURIComponent(decodedUrl);
        } catch (err) {
          return new Response('错误: 无效的 Base64 编码 - ' + err.message, {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      } else {
        // 这是相对路径请求，比如 /p/01.m3u8?msisdn=...
        // 我们需要从原始 M3U8 请求中获取基础 URL 来构建完整 URL
        
        // 由于无法直接获取原始请求上下文，我们需要一种新的策略
        // 假设这是从主 M3U8 派生的请求，我们需要存储原始 URL 的映射
        // 但 Cloudflare Workers 是无状态的，所以我们需要另一种方法
        
        // 策略：尝试从 Referer 获取原始 URL，然后构建相对路径
        const referer = request.headers.get('Referer');
        if (referer) {
          try {
            const refererUrl = new URL(referer);
            // 如果 Referer 也是我们的代理 URL，从中提取原始 URL
            const refererPathParts = refererUrl.pathname.split('/');
            if (refererPathParts[1] === 'p' && refererPathParts[2]) {
              const refererEncoded = refererPathParts[2];
              if (refererEncoded.length >= 4 && refererEncoded.match(/^[A-Za-z0-9+/]*={0,2}$/)) {
                const refererDecoded = safeDecode(refererEncoded);
                const refererOriginal = decodeURIComponent(refererDecoded);
                
                // 构建相对路径的完整 URL
                const relativePath = encodedTarget + url.search;
                const finalTarget = new URL(relativePath, refererOriginal).href;
                
                targetUrl = finalTarget;
              }
            }
          } catch (e) {
            // 如果 Referer 解析失败，继续下面的处理
          }
        }
        
        // 如果仍然无法构建目标 URL，返回错误
        if (!targetUrl) {
          return new Response(`错误: 无法处理相对路径请求: ${encodedTarget}\n\n请确保主 M3U8 文件被正确重写。`, {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      }
    }
  }

  // === 3. 验证目标 URL ===
  if (!targetUrl) {
    return new Response('v1错误: 请提供目标 URL (url 参数或 /p/... 路径)', {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  try {
    targetUrl = new URL(targetUrl).href;
  } catch (err) {
    return new Response('错误: 无效的 URL 格式', {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  // === 4. 设置代理请求选项 ===
  const proxyOptions = {
    method: request.method,
    headers: {
      'User-Agent': FAKE_UA,
      'Referer': new URL(targetUrl).origin,
      'Origin': url.origin
    },
    redirect: 'follow'
  };

  delete proxyOptions.headers['host'];
  delete proxyOptions.headers['origin'];
  delete proxyOptions.headers['referer'];

  // === 5. 发起代理请求 ===
  try {
    const response = await fetch(targetUrl, proxyOptions);

    // 构造新的响应头
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newHeaders.set(key, value);
    });

    // 直接返回响应，不进行重写（因为相对路径已经处理了）
    return new Response(response.body, {
      ...response,
      headers: newHeaders
    });

  } catch (err) {
    console.error('代理请求失败:', err);
    return new Response(`代理请求失败: ${err.message}`, {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
