// worker.js - Cloudflare Worker 代理脚本
// 功能：代理 M3U8/HLS 流媒体，解决跨域问题，重写 TS 片段 URL

// 基本配置
const DEFAULT_UPSTREAM = 'https://example.com'; // 默认上游，可根据需要修改
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 主处理函数
async function handleRequest(request) {
    // 处理 CORS Preflight (OPTIONS) 请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: CORS_HEADERS,
        });
    }

    const url = new URL(request.url);
    let targetUrl = url.searchParams.get('url');

    // 如果没有提供 url 参数，返回使用说明
    if (!targetUrl) {
        return new Response(
            'Usage: /?url=<encoded_url>\nExample: /?url=https%3A%2F%2Fexample.com%2Fstream.m3u8',
            { status: 400, headers: { 'Content-Type': 'text/plain' } }
        );
    }

    // 解码 URL 参数
    targetUrl = decodeURIComponent(targetUrl);

    // ⭐ 防止递归调用检查 ⭐
    const recursivePatterns = [
        'm3u.521986.xyz',
        url.hostname, // 当前 Worker 域名
        '?url=',
        '%3Furl%3D'
    ];
    
    const isRecursive = recursivePatterns.some(pattern => 
        targetUrl.includes(pattern)
    );
    
    if (isRecursive) {
        return new Response(
            '错误: 检测到递归代理调用，请检查输入的URL。', 
            { 
                status: 400, 
                headers: { 
                    'Content-Type': 'text/plain',
                    ...CORS_HEADERS 
                } 
            }
        );
    }

    try {
        // 处理 M3U8 文件
        if (targetUrl.endsWith('.m3u8')) {
            return handleM3U8Request(targetUrl, request, url);
        }
        
        // 处理 TS 片段或其他资源
        return handleMediaRequest(targetUrl, request);
        
    } catch (error) {
        return new Response(`Worker Error: ${error.message}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS },
        });
    }
}

// 处理 M3U8 清单文件
async function handleM3U8Request(targetUrl, originalRequest, workerUrl) {
    // 获取原始 M3U8 内容
    const response = await fetch(targetUrl, {
        headers: getForwardHeaders(originalRequest.headers),
    });

    if (!response.ok) {
        return response;
    }

    let m3uContent = await response.text();

    // 重写 M3U8 内容中的 URL
    m3uContent = rewriteM3U8Content(m3uContent, targetUrl, workerUrl);

    return new Response(m3uContent, {
        status: response.status,
        headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            ...CORS_HEADERS,
            ...getCacheHeaders(response.headers),
        },
    });
}

// 重写 M3U8 内容
function rewriteM3U8Content(content, originalUrl, workerUrl) {
    const baseUrl = new URL(originalUrl);
    baseUrl.pathname = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);

    return content.split('\n').map(line => {
        // 跳过注释和空行
        if (line.startsWith('#') || line.trim() === '') {
            return line;
        }

        // 处理相对路径
        if (!line.startsWith('http')) {
            try {
                line = new URL(line, baseUrl).toString();
            } catch (e) {
                console.warn(`无法解析相对路径: ${line}`);
                return line;
            }
        }

        // 将 TS 片段 URL 通过 Worker 代理
        if (line.endsWith('.ts') || line.includes('.ts?')) {
            return `${workerUrl.origin}/?url=${encodeURIComponent(line)}`;
        }

        // 处理嵌套的 M3U8
        if (line.endsWith('.m3u8')) {
            return `${workerUrl.origin}/?url=${encodeURIComponent(line)}`;
        }

        return line;
    }).join('\n');
}

// 处理媒体请求（TS 片段等）
async function handleMediaRequest(targetUrl, originalRequest) {
    const response = await fetch(targetUrl, {
        headers: getForwardHeaders(originalRequest.headers),
    });

    if (!response.ok) {
        return response;
    }

    return new Response(response.body, {
        status: response.status,
        headers: {
            'Content-Type': response.headers.get('Content-Type') || 'video/mp2t',
            ...CORS_HEADERS,
            ...getCacheHeaders(response.headers),
        },
    });
}

// 获取转发头（可选）
function getForwardHeaders(originalHeaders) {
    const headers = new Headers();
    
    // 可以添加需要转发的头，例如 Referer
    const referer = originalHeaders.get('Referer');
    if (referer) {
        headers.set('Referer', referer);
    }
    
    return headers;
}

// 获取缓存头（可选）
function getCacheHeaders(originalHeaders) {
    const headers = {};
    
    // 从原始响应中复制缓存头
    const cacheControl = originalHeaders.get('Cache-Control');
    if (cacheControl) {
        headers['Cache-Control'] = cacheControl;
    } else {
        // 默认缓存 5 分钟
        headers['Cache-Control'] = 'public, max-age=300';
    }
    
    return headers;
}

// Worker 入口
addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});
