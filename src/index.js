// 修复后的Worker代码
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // 处理CORS预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      }
    })
  }

  const url = new URL(request.url)
  let targetUrl = url.searchParams.get('url')

  if (!targetUrl) {
    return new Response('错误: 请提供URL参数', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }

  try {
    // 解码URL参数
    targetUrl = decodeURIComponent(targetUrl)
    
    // 清理请求头
    const headers = new Headers()
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    headers.set('Accept', '*/*')
    headers.set('Accept-Language', 'en-US,en;q=0.5')
    headers.set('Accept-Encoding', 'gzip, deflate')
    headers.set('Connection', 'keep-alive')
    headers.set('DNT', '1')
    
    // 添加Referer和Origin头，模拟浏览器行为
    const targetUrlObj = new URL(targetUrl)
    headers.set('Referer', targetUrlObj.origin)
    headers.set('Origin', targetUrlObj.origin)

    // 发起请求
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: headers,
      redirect: 'follow'
    })

    // 处理响应
    if (!response.ok) {
      return new Response(`上游服务器错误: ${response.status}`, {
        status: response.status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    // 获取内容类型
    const contentType = response.headers.get('content-type') || ''
    const isPlaylist = contentType.includes('mpegurl') || 
                       contentType.includes('mpegURL') || 
                       targetUrl.includes('.m3u8') || 
                       targetUrl.includes('.m3u')

    if (isPlaylist) {
      // 处理M3U播放列表
      const text = await response.text()
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1)
      const workerBase = `${url.origin}/`
      
      // 重写播放列表中的链接
      const rewrittenText = text.split('\n').map(line => {
        const trimmedLine = line.trim()
        if (trimmedLine && !trimmedLine.startsWith('#')) {
          try {
            // 处理相对路径
            let absoluteUrl = trimmedLine
            if (!trimmedLine.startsWith('http')) {
              absoluteUrl = new URL(trimmedLine, baseUrl).toString()
            }
            
            // 避免递归代理
            if (!absoluteUrl.includes(url.hostname)) {
              return `${workerBase}?url=${encodeURIComponent(absoluteUrl)}`
            }
          } catch (e) {
            console.error('URL处理错误:', e.message)
          }
        }
        return line
      }).join('\n')

      return new Response(rewrittenText, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      })
    } else {
      // 处理媒体文件
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      })
    }
  } catch (error) {
    console.error('Worker错误:', error.message)
    
    return new Response(`代理错误: ${error.message}`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
}
