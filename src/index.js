/**
 * M3U/CORS 代理服务 - 调试版（带详细日志）
 */

// CORS 允许的头部
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

// M3U8/TS 等媒体内容类型
const mediaTypes = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'video/mp2t',
  'application/octet-stream'
];

// 模拟设备的 User-Agent
const FAKE_UA = 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36';

// HTMLRewriter 用于重写 M3U8 中的链接为代理格式
class M3URewriter {
  constructor(requestUrl, originalTargetUrl) {
    this.requestUrl = new URL(requestUrl);
    this.originalTargetUrl = new URL(originalTargetUrl);
    console.log('M3URewriter 初始化:', {
      requestUrl: requestUrl,
      originalTargetUrl: originalTargetUrl
    });
  }

  element(element) {
    console.log('M3URewriter.element called');
  }

  text(text) {
    console.log('M3URewriter.text called with:', text.text.substring(0, 100) + '...');
    
    let newText = text.text;
    
    // 重写完整 URL
    const originalLength = newText.length;
    newText = newText.replace(/(https?:\/\/[^\s"'\]]+)/g, (match) => {
      console.log('重写完整 URL:', match);
      if (match.includes(this.requestUrl.host)) {
        console.log('跳过已代理链接:', match);
        return match;
      }
      const encodedTarget = btoa(encodeURIComponent(match));
      const newUrl = `${this.requestUrl.origin}/p/${encodedTarget}`;
      console.log('重写为代理链接:', newUrl);
      return newUrl;
    });
    
    // 重写相对路径（.m3u8, .ts 等）
    newText = newText.replace(/([^\n#]*\.(m3u8|ts)[^\s]*)/g, (match) => {
      console.log('发现相对路径:', match);
      if (match.startsWith('http')) {
        console.log('跳过完整 URL:', match);
        return match; // 已是完整 URL
      }
      if (match.includes(this.requestUrl.host)) {
        console.log('跳过已代理链接:', match);
        return match; // 已是代理链接
      }
      
      // 将相对路径转换为完整 URL
      try {
        const absoluteUrl = new URL(match, this.originalTargetUrl).href;
        const encodedTarget = btoa(encodeURIComponent(absoluteUrl));
        const newUrl = `${this.requestUrl.origin}/p/${encodedTarget}`;
        console.log('相对路径重写为:', newUrl);
        return newUrl;
      } catch (e) {
        console.log('相对路径解析失败:', match, e.message);
        return match; // 保持原样
      }
    });
    
    if (originalLength !== newText.length) {
      console.log('M3U8 内容已重写，长度变化:', originalLength, '->', newText.length);
    }
    
    text.replace(newText, { html: false });
  }
}

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
  console.log('=== 处理请求 ===', {
    method: request.method,
    url: request.url,
    pathname: url.pathname,
    search: url.search
  });

  // === 1. 处理 OPTIONS 预检请求 ===
  if (request.method === 'OPTIONS') {
    console.log('处理 OPTIONS 请求');
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // === 2. 解析目标 URL：支持多种模式 ===
  let targetUrl = null;
  let isBase64Encoded = false;

  // 模式 1: ?url= 参数代理（向后兼容）
  const urlParam = url.searchParams.get('url');
  if (urlParam) {
    console.log('检测到 url 参数:', urlParam);
    try {
      targetUrl = new URL(decodeURIComponent(urlParam)).href;
      console.log('解析出的目标 URL:', targetUrl);
    } catch (err) {
      console.log('URL 参数解析失败:', err.message);
      return new Response('错误: 无效的 URL 格式 (url 参数)', {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }

  // 模式 2: Base64 路径代理 /p/...
  if (!targetUrl) {
    const pathParts = url.pathname.split('/');
    console.log('路径分割:', pathParts);
    
    if (pathParts[1] === 'p' && pathParts[2]) {
      const encodedTarget = pathParts[2];
      console.log('检测到 /p/ 路径，编码内容:', encodedTarget);
      
      // 检查是否是 Base64 编码
      if (encodedTarget.length >= 4 && encodedTarget.match(/^[A-Za-z0-9+/]*={0,2}$/)) {
        console.log('检测到 Base64 编码，尝试解码...');
        // Base64 编码的完整 URL
        try {
          const decodedUrl = safeDecode(encodedTarget);
          targetUrl = decodeURIComponent(decodedUrl);
          isBase64Encoded = true;
          console.log('Base64 解码成功，目标 URL:', targetUrl);
        } catch (err) {
          console.log('Base64 解码失败:', err.message);
          return new Response('错误: 无效的 Base64 编码 - ' + err.message, {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      } else {
        // 这是问题所在：收到的是相对路径请求
        console.log('检测到非 Base64 格式，可能是相对路径:', encodedTarget);
        return new Response(`错误: 无效请求格式。收到相对路径请求: ${encodedTarget}\n请确保 M3U8 内容被正确重写。`, {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }
  }

  // === 3. 验证目标 URL ===
  if (!targetUrl) {
    console.log('未找到目标 URL');
    return new Response('错误: 请提供目标 URL (url 参数或 /p/... 路径)', {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  try {
    targetUrl = new URL(targetUrl).href;
    console.log('验证后的目标 URL:', targetUrl);
  } catch (err) {
    console.log('目标 URL 验证失败:', err.message);
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
    console.log('开始代理请求:', targetUrl);
    const response = await fetch(targetUrl, proxyOptions);

    // 获取原始响应类型
    const contentType = response.headers.get('content-type') || '';
    const isMedia = mediaTypes.some(type => contentType.includes(type));
    const isHtml = contentType.includes('text/html') || contentType.includes('text/plain');
    
    console.log('响应内容类型:', contentType, '是否为媒体:', isMedia, '是否为HTML/文本:', isHtml);

    // 构造新的响应头
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newHeaders.set(key, value);
    });

    // 如果是 M3U8 或文本类媒体，使用 HTMLRewriter 重写内容
    if (isMedia || isHtml) {
      console.log('检测到媒体内容，应用 M3U8 重写器');
      return new HTMLRewriter()
        .on('body', new M3URewriter(request.url, targetUrl))
        .transform(
          new Response(response.body, {
            ...response,
            headers: newHeaders
          })
        );
    }

    console.log('返回普通响应');
    // 普通响应直接返回
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
