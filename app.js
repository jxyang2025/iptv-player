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

// ⭐ 修复步骤 1: 专门处理 OPTIONS (CORS Preflight) 请求
function handleOptions(request) {
  if (request.headers.get('Origin') !== null &&
      request.headers.get('Access-Control-Request-Method') !== null &&
      request.headers.get('Access-Control-Request-Headers') !== null) {
    // 响应预检请求，返回 200 OK 和 CORS 头部
    return addCORSHeaders(new Response(null, {
      status: 200,
    }));
  } else {
    // 非法 OPTIONS 请求
    return new Response(null, {
      status: 400,
    });
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  
  // ⭐ 修复步骤 2: 在处理 GET/POST 之前，先处理 OPTIONS
  if (request.method === 'OPTIONS') {
    return handleOptions(request);
  }
  
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  // 保持与前端 app.js 匹配的 Worker 代理基础 URL
  const WORKER_PROXY_BASE_URL = url.origin + url.pathname; 

  if (!targetUrl) {
    const errorResponse = new Response('错误: 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }

  // ⭐ 关键修复：清理和设置请求头部，以模仿真实的客户端请求，避免源站拒绝 (如 VLC)
  const headers = new Headers(request.headers);
  // 移除可能导致问题的头部
  headers.delete('Host');
  headers.delete('Connection');
  headers.delete('cf-ray');
  headers.delete('x-forwarded-for'); 
  // 模仿浏览器的 User-Agent，增加成功率
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
  // 尝试设置 Referer，对于某些源站是必需的（模仿请求来源）
  headers.set('Referer', new URL(targetUrl).origin + '/');
  // 确保 Content-Type 是通用的
  headers.set('Content-Type', 'application/json, text/plain, */*');


  try {
    // 向目标 URL 发起请求，注意携带修改后的 headers 
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      redirect: 'follow'
    });
    
    // --- M3U 文件内容重写逻辑 ---
    
    // 检查内容类型是否为 M3U/HLS 播放列表
    const contentType = response.headers.get('content-type') || '';
    const isM3U = contentType.includes('application/vnd.apple.mpegurl') || 
                  contentType.includes('application/x-mpegurl') || 
                  targetUrl.toLowerCase().endsWith('.m3u8') || 
                  targetUrl.toLowerCase().endsWith('.m3u');

    if (response.ok && isM3U) {
        const text = await response.text();
        // 获取 M3U/M3U8 文件的基础 URL，用于解析相对路径
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

        // 重写 M3U/M3U8 文件内容，将所有相对或绝对链接都包装到 Worker 代理中
        const rewrittenText = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            // 只处理非注释行且包含链接的行
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                // 使用 M3U 文件本身的基准 URL 来解析相对路径
                try {
                    const fullLink = new URL(trimmedLine, baseUrl).href;
                    // 构造代理 URL: WORKER_PROXY_BASE_URL + ?url=Original_URL
                    return WORKER_PROXY_BASE_URL + '?url=' + encodeURIComponent(fullLink);
                } catch(e) {
                    // 如果解析失败，返回原样
                    return line;
                }
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
        // 标准代理 (适用于 TS 视频片段、密钥文件或非 M3U 请求)
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
    // 代理请求失败：返回 500 错误
    const errorResponse = new Response(`代理请求失败: ${e.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }
}
