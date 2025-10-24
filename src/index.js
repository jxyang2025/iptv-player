// Worker 脚本 - 解决 CORS, HLS 相对路径, 并增强 Header 兼容性
// **请将此代码部署到 Cloudflare Worker**

// 辅助函数：确保所有响应都包含 CORS 头部
function addCORSHeaders(response) {
    // 确保内容可读
    const newResponse = new Response(response.body, response);
    // 允许所有来源访问
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
  const url = new URL(request.url);
  // 从 URL 参数中获取目标地址
  const targetUrl = url.searchParams.get('url');
  
  // Worker 部署后的基准 URL，用于重写 M3U8 内部的相对链接
  const WORKER_PROXY_BASE_URL = url.origin + '/'; 

  if (!targetUrl) {
    // 错误处理
    const errorResponse = new Response('错误: 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }

  // 关键修复：清理和设置请求头部，以模拟真实浏览器请求，防止被源站拒绝
  const headers = new Headers(request.headers);
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
  headers.set('Accept-Encoding', 'gzip, deflate, br');
  headers.delete('if-none-match'); // 清理缓存相关头，防止 304 错误

  const targetURLObj = new URL(targetUrl);
  // 设置 Referer 为源站域名，有时有助于通过防盗链检查
  headers.set('Referer', targetURLObj.origin);
  
  // 构建代理请求
  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: headers,
    redirect: 'follow'
  });

  try {
    const response = await fetch(proxyRequest);

    // 如果源站返回 304 Not Modified，这是客户端请求头导致的。
    // 在上一步已删除 if-none-match，但如果仍然收到 304，我们返回一个错误提示。
    if (response.status === 304) {
        // 返回一个明确的错误，以便客户端进行提示
        return addCORSHeaders(new Response("代理请求失败：源站返回状态码 304 Not Modified。请尝试清除浏览器缓存。", {
            status: 400,
            statusText: "Not Modified Error"
        }));
    }

    // 判断是否是 M3U8 文件或 M3U 播放列表
    const isPlaylist = targetUrl.toLowerCase().endsWith('.m3u8') || targetUrl.toLowerCase().endsWith('.m3u') || 
                       (response.headers.get('content-type') || '').includes('application/vnd.apple.mpegurl');
    
    if (isPlaylist) {
        // M3U/M3U8 播放列表重写逻辑
        const text = await response.text();
        const baseDir = targetURLObj.href.substring(0, targetURLObj.href.lastIndexOf('/') + 1);

        // 重写相对路径：将 M3U8 内部的相对路径转换为通过 Worker 代理的绝对路径
        const rewrittenContent = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            // 忽略注释行和空行
            if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
                return line;
            }
            
            // 如果是相对路径 (不包含协议//)
            if (!trimmedLine.startsWith('http')) {
                // 组合成绝对路径
                const absoluteUrl = new URL(trimmedLine, baseDir).href;
                // 重写为通过 Worker 代理的链接
                return WORKER_PROXY_BASE_URL + '?url=' + encodeURIComponent(absoluteUrl);
            }
            
            // 如果是绝对路径 (已经是 http/https)，也通过 Worker 代理
            return WORKER_PROXY_BASE_URL + '?url=' + encodeURIComponent(trimmedLine);

        }).join('\n');

        // 创建重写后的响应
        const newResponse = new Response(rewrittenContent, {
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
    // 代理请求失败：返回 500 错误时
    console.error('Proxy Fetch Error:', e);
    // 返回 502 Bad Gateway 错误，因为 Worker 无法从源站获取内容
    return addCORSHeaders(new Response(`代理请求失败：无法连接到源站或发生内部错误。错误详情：${e.message}`, { 
        status: 502, 
        statusText: 'Bad Gateway'
    }));
  }
}
