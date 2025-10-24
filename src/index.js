// Worker 脚本 - 解决 CORS, HLS 相对路径, 并增强 Header 兼容性

// 辅助函数：确保所有响应都包含 CORS 头部
function addCORSHeaders(response) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', '*');
    // 转发预检请求的头部
    newResponse.headers.set('Access-Control-Max-Age', '86400');
    return newResponse;
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // ⭐ 处理 CORS Preflight (OPTIONS) 请求 ⭐
  if (request.method === 'OPTIONS') {
    return addCORSHeaders(new Response(null, { status: 200 }));
  }
  
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  const WORKER_PROXY_BASE_URL = url.origin + '/'; 

  if (!targetUrl) {
    const errorResponse = new Response('错误: 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }

  // ⭐ 优化：清理和设置请求头部，以增强对源站的兼容性 ⭐
  const newHeaders = new Headers(request.headers);
  newHeaders.delete('host'); // 移除host
  newHeaders.delete('accept-encoding'); // 移除编码，防止Worker/源站编码不匹配

  // 伪造标准浏览器头部
  newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
  newHeaders.set('Referer', new URL(targetUrl).origin + '/'); // 伪造 Referer
  
  let response;
  try {
    response = await fetch(targetUrl, {
      method: request.method,
      headers: newHeaders,
      redirect: 'follow',
      body: request.body
    });

    // ⭐ 关键检查：如果源站返回 4xx/5xx 错误，Worker 应该直接返回这个错误，而不是继续解析 ⭐
    if (!response.ok) {
        // 如果原始请求失败（例如 403 Forbidden 或 404 Not Found），我们返回一个包含详细信息的响应
        const errorBody = `代理请求失败：源站返回状态码 ${response.status} ${response.statusText}。\n\n提示：此错误通常意味着您使用的视频链接已过期或被源站拒绝。`;
        const errorResponse = new Response(errorBody, { 
            status: 502, // 使用 502 Bad Gateway 表示代理下游错误
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
        return addCORSHeaders(errorResponse);
    }

    // 辅助函数：重写 M3U8 中的相对链接为绝对链接，并使用 Worker 代理
    function rewriteLink(link) {
      if (link.startsWith('http') || link.startsWith('https') || link.startsWith('//')) {
        return link; // 已经是绝对链接
      }
      // 处理相对路径
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const absoluteUrl = new URL(link, baseUrl).href;
      // 使用 Worker 代理封装
      return `${WORKER_PROXY_BASE_URL}?url=${encodeURIComponent(absoluteUrl)}`;
    }
    
    // 检查是否是 M3U 或 M3U8 文件
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('mpegurl') || contentType.includes('application/x-mpegURL') || targetUrl.endsWith('.m3u') || targetUrl.endsWith('.m3u8')) {
        
        // 读取文本内容
        const text = await response.text();
        
        // 重写 M3U/M3U8 中的所有链接（片段或子播放列表）
        const rewrittenText = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                // 仅重写非注释行
                return rewriteLink(trimmedLine);
            }
            return line;
        }).join('\n');

        // 创建重写后的响应
        const newResponse = new Response(rewrittenText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });

        // 强制设置为正确的 MIME 类型
        newResponse.headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        
        // 添加 CORS 头部并返回
        return addCORSHeaders(newResponse);

    } else {
        // 标准代理 (适用于 TS 视频片段或密钥文件)
        const newResponse = new Response(response.body, response);

        // 优化：防止 Cloudflare Edge 对视频内容过度缓存
        const responseContentType = newResponse.headers.get('content-type') || '';
        if (responseContentType.includes('video') || responseContentType.includes('application/octet-stream')) {
             newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
        
        // 添加 CORS 头部并返回
        return addCORSHeaders(newResponse);
    }

  } catch (e) {
    // 代理请求失败：返回 504 Gateway Timeout (更贴切) 或 500
    // 此处捕获的是网络级错误（如 DNS 失败、超时）
    const errorResponse = new Response(`代理请求目标 URL 失败（网络级错误）：${e.message}`, { status: 504 });
    return addCORSHeaders(errorResponse);
  }
}
