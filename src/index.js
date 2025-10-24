// Worker 脚本 - 解决 CORS, HLS 相对路径, 并增强 Header 兼容性
// ⭐ 关键修复: 彻底解决递归代理、Mixed Content和双重代理问题

// 辅助函数：确保所有响应都包含 CORS 头部
function addCORSHeaders(response) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', '*');
    newResponse.headers.set('Access-Control-Max-Age', '86400');
    return newResponse;
}

// 辅助函数：自动将 HTTP 转换为 HTTPS
function ensureHTTPS(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.protocol === 'http:') {
            urlObj.protocol = 'https:';
            return urlObj.toString();
        }
    } catch (e) {
        // URL解析失败，保持原样
    }
    return url;
}

// 辅助函数：检查是否为递归代理链接（增强版）
function isRecursiveProxyLink(link, workerBase) {
    if (!link) return false;
    
    // 检查是否包含代理模式
    const proxyPatterns = [
        '/?url=', '?url=', '%2F%3Furl%3D', '%3Furl%3D',
        'worker.dev', 'pages.dev', 'm3u.521986.xyz'
    ];
    
    return proxyPatterns.some(pattern => link.includes(pattern));
}

// 辅助函数：从递归链接中提取原始URL（增强版）
function extractOriginalUrl(recursiveUrl, workerBase) {
    try {
        let currentUrl = recursiveUrl;
        let depth = 0;
        const maxDepth = 5; // 防止无限循环
        
        while (depth < maxDepth) {
            try {
                const urlObj = new URL(currentUrl);
                
                // 如果当前URL不是代理格式，返回它
                if (!urlObj.searchParams.has('url')) {
                    return ensureHTTPS(currentUrl);
                }
                
                const extractedUrl = urlObj.searchParams.get('url');
                if (!extractedUrl) break;
                
                // 解码URL
                currentUrl = decodeURIComponent(extractedUrl);
                depth++;
                
            } catch (e) {
                // 不是有效URL，返回确保HTTPS的版本
                return ensureHTTPS(currentUrl);
            }
        }
        
        return ensureHTTPS(currentUrl);
        
    } catch (e) {
        return ensureHTTPS(recursiveUrl);
    }
}

// 辅助函数：将 M3U/M3U8 中的链接重写为指向 Worker 代理的链接
function rewriteLink(link, workerBase, targetUrl) {
    // 1. 跳过空行和注释
    if (!link || link.startsWith('#') || link.trim() === '') {
        return link;
    }
    
    // 2. ⭐ 关键修复: 检查是否为递归代理链接 ⭐
    if (isRecursiveProxyLink(link, workerBase)) {
        // 如果是递归链接，尝试提取原始URL
        const originalUrl = extractOriginalUrl(link, workerBase);
        return ensureHTTPS(originalUrl);
    }
    
    // 3. 检查链接是否为媒体文件（TS、MP4等），不重写非M3U8链接
    const mediaExtensions = ['.ts', '.mp4', '.m4s', '.aac', '.mp3', '.webm', '.mkv'];
    const isMediaFile = mediaExtensions.some(ext => 
        link.toLowerCase().includes(ext) && !link.toLowerCase().includes('.m3u8')
    );
    
    if (isMediaFile) {
        return ensureHTTPS(link); // 不重写媒体文件链接，但确保HTTPS
    }
    
    // 4. 尝试将链接解析为绝对 URL
    let absoluteUrl = link;
    try {
        const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        absoluteUrl = new URL(link, base).toString();
    } catch (e) {
        // 保持原样，但确保HTTPS
        return ensureHTTPS(link);
    }
    
    // 5. 再次检查是否为递归链接（转换后）
    if (isRecursiveProxyLink(absoluteUrl, workerBase)) {
        const originalUrl = extractOriginalUrl(absoluteUrl, workerBase);
        return ensureHTTPS(originalUrl);
    }
    
    // 6. 只重写M3U8相关的链接
    const isM3U8Link = absoluteUrl.includes('.m3u8') || absoluteUrl.includes('.m3u');
    if (!isM3U8Link) {
        return ensureHTTPS(absoluteUrl); // 不重写非M3U8链接，但确保HTTPS
    }
    
    // 7. 重写为 Worker 代理链接（确保使用HTTPS）
    const secureUrl = ensureHTTPS(absoluteUrl);
    const newLink = `${workerBase}?url=${encodeURIComponent(secureUrl)}`;
    return newLink;
}

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    // 处理 CORS Preflight (OPTIONS) 请求
    if (request.method === 'OPTIONS') {
        return addCORSHeaders(new Response(null, { status: 200 }));
    }
    
    const url = new URL(request.url);
    let targetUrl = url.searchParams.get('url');
    
    // 使用请求的 URL origin 作为 Worker 代理的基地址
    const WORKER_PROXY_BASE_URL = url.origin + '/';

    if (!targetUrl) {
        const errorResponse = new Response('错误: 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
            status: 400,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
        return addCORSHeaders(errorResponse);
    }

    // ⭐ 关键修复: 自动将目标 URL 的 HTTP 转换为 HTTPS ⭐
    targetUrl = ensureHTTPS(targetUrl);
    
    // 清理请求头部
    const headers = new Headers();
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    headers.set('Accept', '*/*');
    headers.set('Accept-Language', 'en-US,en;q=0.5');
    
    // 添加 Referer 和 Origin 头
    try {
        const targetUrlObj = new URL(targetUrl);
        headers.set('Referer', targetUrlObj.origin);
        headers.set('Origin', targetUrlObj.origin);
    } catch (e) {
        // 忽略URL解析错误
    }

    try {
        // 核心代理请求
        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: headers,
            redirect: 'follow'
        });

        const responseContentType = response.headers.get('content-type') || '';
        
        // 检查内容是否为 M3U/M3U8（只处理文本类型的M3U8文件）
        const isM3U8Content = (responseContentType.includes('application/vnd.apple.mpegurl') || 
                              responseContentType.includes('application/x-mpegURL') || 
                              responseContentType.includes('audio/mpegurl')) &&
                              !responseContentType.includes('video') &&
                              !responseContentType.includes('audio');
        
        const isM3U8Extension = targetUrl.includes('.m3u8') || targetUrl.includes('.m3u');
        const isSmallTextFile = response.headers.get('Content-Length') < 100000 && // 增大文件大小限制
                               (responseContentType.includes('text/plain') || 
                                responseContentType.includes('application/'));

        if ((isM3U8Content || isM3U8Extension) && isSmallTextFile) {
            // 如果 M3U8 索引文件本身获取失败，直接返回错误状态
            if (!response.ok) {
                const errorResponse = new Response(`上游服务器错误: ${response.status} ${response.statusText}`, {
                    status: response.status,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
                return addCORSHeaders(errorResponse);
            }

            // 获取文本内容
            const text = await response.text();
            
            // 使用 rewriteLink 辅助函数重写所有非注释行中的链接
            const rewrittenText = text.split('\n').map(line => {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.startsWith('#')) {
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

            // 设置正确的 MIME 类型
            newResponse.headers.set('Content-Type', 'application/vnd.apple.mpegurl');
            
            // 添加 CORS 头部并返回
            return addCORSHeaders(newResponse);

        } else {
            // 处理媒体文件和其他内容（MP4、TS等）
            const newHeaders = new Headers(response.headers);
            newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            
            const newResponse = new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            });
            
            return addCORSHeaders(newResponse);
        }

    } catch (e) {
        // 代理请求失败
        const errorBody = `代理请求失败: ${e.message || '网络错误'}`;
        return addCORSHeaders(new Response(errorBody, {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }));
    }
}
