// Worker 脚本 - 解决 CORS, HLS 相对路径, 并增强 Header 兼容性
// ⭐ 关键更新: 阻止 Worker 代理指向自身的链接，修复 522 递归错误，并重写 M3U8 中的链接。

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

/**
 * 辅助函数：将 M3U/M3U8 中的链接重写为指向 Worker 代理的链接
 * @param {string} link - M3U/M3U8 文件中解析到的链接
 * @param {string} workerBase - Worker 自身的基准 URL (例如: https://your.workers.dev/)
 * @param {string} targetUrl - 当前 M3U/M3U8 文件的原始 URL，用作解析相对路径的基准
 * @returns {string} - 重写后的 Worker 代理 URL
 */
function rewriteLink(link, workerBase, targetUrl) {
    // 1. ⭐ CRUCIAL FIX: 检查链接是否已经指向 Worker 代理本身 ⭐
    // 如果链接已经是代理格式 (例如: worker.dev/?url=...)，则不进行二次重写
    if (link.startsWith(workerBase)) {
        // 由于客户端可能输入双重代理，Worker 内部如果遇到双重代理，
        // 应该尝试解析并返回内部链接，但保险起见，这里直接返回，让客户端或下一层Worker处理。
        console.log(`Skipping rewrite for already proxied link: ${link}`);
        return link; 
    }
    
    // 2. 尝试将链接解析为绝对 URL
    let absoluteUrl = link;
    if (!link.startsWith('http')) {
        try {
             // 使用目标 URL (targetUrl) 作为基准解析相对路径
             absoluteUrl = new URL(link, targetUrl).href;
        } catch (e) {
             console.error(`Relative URL resolution failed for: ${link} based on ${targetUrl}`, e);
             return link; // 失败则返回原链接
        }
    }
    
    // 3. 确保链接是完整的 URL，并进行编码
    const encodedLink = encodeURIComponent(absoluteUrl);
    return `${workerBase}?url=${encodedLink}`;
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url);
  
  // ⭐ 处理 CORS Preflight (OPTIONS) 请求 ⭐
  if (request.method === 'OPTIONS') {
    return addCORSHeaders(new Response(null, { status: 204 }));
  }

  const targetUrl = url.searchParams.get('url');
  // WORKER_PROXY_BASE_URL 是 Worker 自身的地址，用于重写 M3U/M3U8 链接
  const WORKER_PROXY_BASE_URL = url.origin + '/'; 

  if (!targetUrl) {
    const errorResponse = new Response('错误: 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }

  try {
    // 1. 准备请求头部
    const requestHeaders = new Headers(request.headers);
    
    // 关键修复: 移除可能导致 304/206 的头部，强制 Worker 总是获取最新完整内容
    requestHeaders.delete('If-Modified-Since');
    requestHeaders.delete('If-None-Match');
    
    // 移除 Range 头部，防止 M3U/M3U8 文件收到 206 导致读取错误。
    if (targetUrl.toLowerCase().endsWith('.m3u') || targetUrl.toLowerCase().endsWith('.m3u8') || targetUrl.includes('interface.txt')) {
        requestHeaders.delete('Range');
    }
    
    // 移除 Worker 转发时不需要的头部
    requestHeaders.delete('host');
    requestHeaders.delete('accept-encoding'); 
    
    // 伪造标准浏览器头部 (可选但推荐)
    requestHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
    // 使用 targetUrl 的 origin 作为 Referer
    try {
        const targetOrigin = new URL(targetUrl).origin;
        requestHeaders.set('Referer', targetOrigin + '/');
        // 添加 Host 头部，有助于某些 CDN/源站识别
        requestHeaders.set('Host', targetOrigin.replace(/https?:\/\//, ''));
    } catch (e) {
        // 如果 targetUrl 不是有效 URL，忽略 Referer 和 Host 设置
    }

    // 2. 向目标 URL 发起请求
    const response = await fetch(targetUrl, {
        method: request.method,
        headers: requestHeaders, // 使用清理后的头部
        redirect: 'follow'
    });
    
    // 3. 检查是否是 M3U/M3U8 文件 (需要重写内部链接)
    const contentType = response.headers.get('content-type') || '';
    const isPlaylist = targetUrl.toLowerCase().endsWith('.m3u') || targetUrl.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl');

    if (isPlaylist) {
        const text = await response.text();
        
        // 核心 HLS 链接重写逻辑
        const rewrittenText = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            // 检查是否是需要重写的 URL 行（非空、非注释行）
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                // 仅重写非注释行
                return rewriteLink(trimmedLine, WORKER_PROXY_BASE_URL, targetUrl);
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
        // 4. 标准代理 (适用于 TS 视频片段或密钥文件)
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
    console.error("Proxy Error:", e.message);
    const errorBody = `代理请求失败：${e.message || '未知错误'}。提示：请检查您的 M3U 订阅链接是否有效，或源站是否可用。`;
    const errorResponse = new Response(errorBody, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }
}
