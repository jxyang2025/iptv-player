// Worker 脚本 - 解决 CORS, HLS 相对路径, 并增强 Header 兼容性
// ⭐ 关键更新: 阻止 Worker 代理指向自身的链接，修复 522 递归错误。
// ⭐ 修复: 确保当上游 M3U8 返回非 200 状态时，Worker 返回正确的错误状态。
// ⭐ 新增: 自动将 HTTP 转换为 HTTPS 以防止 Mixed Content 错误

// 辅助函数：确保所有响应都包含 CORS 头部
function addCORSHeaders(response) {
    // 复制响应以修改头部
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', '*');
    // 转发预检请求的头部
    newResponse.headers.set('Access-Control-Max-Age', '86400');
    return newResponse;
}

// 辅助函数：将 HTTP URL 转换为 HTTPS
function ensureHTTPS(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.protocol === 'http:') {
            urlObj.protocol = 'https:';
            return urlObj.toString();
        }
    } catch (e) {
        // 如果URL解析失败，保持原样
    }
    return url;
}

// 辅助函数：将 M3U/M3U8 中的链接重写为指向 Worker 代理的链接
function rewriteLink(link, workerBase, targetUrl) {
    // 1. ⭐ CRUCIAL FIX: 检查链接是否已经指向 Worker 代理本身 ⭐
    // 如果链接已经是代理格式 (例如: worker.dev/?url=...)，则不进行二次重写
    if (link.startsWith(workerBase)) {
        return link; 
    }
    
    // 2. 尝试将链接解析为绝对 URL
    let absoluteUrl = link;
    try {
        const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        absoluteUrl = new URL(link, base).toString();
    } catch (e) {
        // 保持原样，让 hls.js 处理（可能导致失败）
        return link; 
    }
    
    // 3. ⭐ 新增: 自动将 HTTP 转换为 HTTPS 以防止 Mixed Content 错误 ⭐
    absoluteUrl = ensureHTTPS(absoluteUrl);
    
    // 4. 检查解析后的 URL 是否是 Worker 代理本身，防止递归调用 (522/1000 错误)
    if (absoluteUrl.startsWith(workerBase)) {
        return absoluteUrl;
    }
    
    // 5. 重写为 Worker 代理链接
    const newLink = `${workerBase}?url=${encodeURIComponent(absoluteUrl)}`;
    return newLink;
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // ⭐ 1. 处理 CORS Preflight (OPTIONS) 请求 ⭐
  if (request.method === 'OPTIONS') {
    return addCORSHeaders(new Response(null, { status: 200 }));
  }
  
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  
  // 使用请求的 URL origin 作为 Worker 代理的基地址
  const WORKER_PROXY_BASE_URL = url.origin + '/'; 

  if (!targetUrl) {
    const errorResponse = new Response('错误: 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }

  // ⭐ 2. 关键修复：清理和设置请求头部，以确保上游服务器接受 Worker 的请求 ⭐
  const headers = new Headers(request.headers);
  headers.delete('host'); // 必须删除，防止与源站冲突
  headers.delete('referer'); // 删除 referer，防止源站检查
  
  // 保持 User-Agent
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36');
  }

  try {
    // ⭐ 3. 新增: 自动将目标 URL 的 HTTP 转换为 HTTPS ⭐
    const secureTargetUrl = ensureHTTPS(targetUrl);
    
    // 4. 核心代理请求
    const response = await fetch(secureTargetUrl, {
      method: request.method,
      headers: headers, // 使用清理后的头部
      redirect: 'follow'
    });

    const responseContentType = response.headers.get('content-type') || '';
    
    // 5. 检查内容是否为 M3U/M3U8 (文本内容，需要重写链接)
    const isM3U8Content = responseContentType.includes('application/vnd.apple.mpegurl') || 
                          responseContentType.includes('application/x-mpegURL') || 
                          responseContentType.includes('audio/mpegurl') || 
                          targetUrl.endsWith('.m3u8') || 
                          targetUrl.endsWith('.m3u');

    if (isM3U8Content || (response.headers.get('Content-Length') < 10000 && responseContentType.includes('text/plain'))) {
        
        // ⭐ 关键修复: 如果 M3U8 索引文件本身获取失败 (例如 403, 404)，直接返回错误状态，不尝试读取 body ⭐
        if (!response.ok) {
            const errorResponse = new Response(response.body, response);
            return addCORSHeaders(errorResponse);
        }

        // 尝试获取文本内容
        const text = await response.text();
        
        // 使用 rewriteLink 辅助函数重写所有非注释行中的链接
        const rewrittenText = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                // 仅重写非注释行
                return rewriteLink(trimmedLine, WORKER_PROXY_BASE_URL, secureTargetUrl);
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
        // 6. 标准代理 (适用于 TS 视频片段或密钥文件或非 M3U8 的其他内容)
        // 直接返回原始响应，确保状态码正确传递 (例如 403, 404)
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
    // 代理请求失败或内部 Worker 错误
    // 这通常是网络错误、DNS 查找失败或 Worker 内部代码错误
    const errorBody = `代理请求失败或 Worker 内部错误: ${e.message || '未知错误'}。提示：请检查您的 M3U/HLS URL是否有效或已过期。`;
    return addCORSHeaders(new Response(errorBody, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    }));
  }
}
