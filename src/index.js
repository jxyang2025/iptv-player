// Worker 脚本 - 解决 CORS, HLS 相对路径, 并对防盗链进行强力清理

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

  // ⭐ 最终尝试：强力清理请求头部
  const newHeaders = new Headers();
  
  // 1. 设置通用的 User-Agent，防止被服务器识别为非浏览器请求
  newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  
  // 2. 移除所有可能泄露代理身份的头部。只保留常用的浏览器头部。
  // 注意：Worker 的 fetch API 会自动处理 Host 头部，这里不需要手动删除。

  try {
    // 代理请求
    const response = await fetch(targetUrl, {
      headers: newHeaders, // 使用强力清理后的头部
      redirect: 'follow'
    });

    // 检查是否是 M3U/M3U8 文件
    const contentType = response.headers.get('content-type') || '';
    const isM3U = contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegURL') || targetUrl.endsWith('.m3u') || targetUrl.includes('iptv.php');

    // M3U/M3U8 内容重写 (Content Rewriting)
    if (isM3U) {
        // 克隆响应并读取内容
        const responseClone = response.clone();
        let text = await responseClone.text();
        
        // 修正 M3U8 基准 URL
        const baseUrlObject = new URL(targetUrl);
        
        // 关键修复：当 M3U8 URL缺少端口时，强制修复为 8880
        if (baseUrlObject.hostname === 'php.jdshipin.com' && !baseUrlObject.port) {
            baseUrlObject.port = '8880';
        }
        
        // 核心重写函数：将所有链接封装成 Worker 代理格式
        const rewriteLink = (link) => {
            // 解析相对链接为绝对链接，基准是修正后的 baseUrlObject
            const absoluteLink = new URL(link, baseUrlObject.href).href;
            // 将绝对链接封装进 Worker 的代理格式
            return `${WORKER_PROXY_BASE_URL}?url=${encodeURIComponent(absoluteLink)}`;
        };

        // 遍历所有行并重写：只处理非注释（#）且非空的行
        text = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                return rewriteLink(trimmedLine);
            }
            return line;
        }).join('\n');

        // 创建重写后的响应
        const newResponse = new Response(text, {
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
    // 代理请求失败：返回 500 错误时，添加 CORS 头部
    const errorResponse = new Response(`代理请求失败: ${e.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }
}
