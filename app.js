document.addEventListener('DOMContentLoaded', () => {
    const iptvUrlInput = document.getElementById('iptv-url');
    const loadButton = document.getElementById('load-playlist');
    const channelListUl = document.getElementById('channels');
    const statusMessage = document.getElementById('status-message');
    const videoElement = document.getElementById('tv-player');
    
    // 初始化 Video.js 播放器
    const player = videojs(videoElement);

    // ==========================================================
    // !!! 关键配置: Cloudflare Worker 代理地址 !!!
    // ==========================================================
    // ⭐⭐ 请将此地址替换为您自己部署的 Cloudflare Worker 域名 ⭐⭐
    // 只有专用的 Worker 代理才能解决 HLS 流（M3U8）的 CORS 跨域和相对路径问题。
    // 公共代理 (如 AllOrigins) 无法正确处理 HLS 视频片段，导致 400 错误。
    // 格式: https://YOUR-IPTV-PROXY.workers.dev/?url=
    const WORKER_PROXY_BASE_URL = 'https://m3u.521986.xyz/?url='; 

    /**
     * 更新状态信息
     * @param {string} message - 要显示的消息
     * @param {string} type - 消息类型 ('info', 'error', 'success')
     */
    function updateStatus(message, type = 'info') {
        statusMessage.textContent = message;
        statusMessage.style.color = {
            'info': 'yellow',
            'error': 'red',
            'success': 'lightgreen'
        }[type] || 'yellow';
    }

    /**
     * 获取 M3U 文件内容 (通过 Worker 代理)
     * @param {string} url - M3U 订阅链接
     * @returns {Promise<string|null>} M3U 文件内容或 null
     */
    async function fetchM3UContent(url) {
        // 更新状态信息以提示使用 Worker 代理
        updateStatus('正在通过 Worker 代理加载 M3U 文件...', 'info');
        
        // 使用 Worker 代理 URL 结构：Worker_URL?url=Original_URL
        const proxyUrl = WORKER_PROXY_BASE_URL + encodeURIComponent(url);

        try {
            // 不再传入自定义 headers，Worker 会自行处理
            const response = await fetch(proxyUrl); 

            if (!response.ok) {
                const errorText = await response.text();
                // 提示用户检查 Worker 地址或源站
                updateStatus(`加载 M3U 失败: 状态码 ${response.status}。请检查 Worker 代理地址是否正确或流源是否有效。`, 'error');
                console.error("Fetch Error Details:", errorText);
                return null;
            }

            const m3uContent = await response.text();
            updateStatus('M3U 文件加载成功！正在解析频道...', 'info');
            return m3uContent;

        } catch (e) {
            updateStatus(`网络请求失败 (请检查 Worker 地址是否正确): ${e.message}`, 'error');
            return null;
        }
    }

    /**
     * 解析 M3U 文件内容
     * @param {string} content - M3U 文件文本内容
     * @returns {Array<{name: string, url: string}>} 频道列表
     */
    function parseM3U(content) {
        const lines = content.split('\n');
        const channels = [];
        let currentChannel = {};

        for (const line of lines) {
            if (line.startsWith('#EXTINF')) {
                // 提取频道名称
                const match = line.match(/,(.*)$/);
                if (match) {
                    currentChannel.name = match[1].trim();
                }
            } else if (line.startsWith('http') || line.startsWith('https')) {
                // 提取频道URL
                currentChannel.url = line.trim();
                if (currentChannel.name && currentChannel.url) {
                    channels.push(currentChannel);
                }
                currentChannel = {}; // 重置
            }
        }
        return channels;
    }

    /**
     * 渲染频道列表
     * @param {Array<{name: string, url: string}>} channels - 频道列表
     */
    function renderChannels(channels) {
        channelListUl.innerHTML = '';
        if (channels.length === 0) {
            channelListUl.innerHTML = '<p>未找到频道。</p>';
            return;
        }

        channels.forEach(channel => {
            const listItem = document.createElement('li');
            const link = document.createElement('a');
            
            link.href = '#';
            link.textContent = channel.name;
            link.dataset.url = channel.url;
            link.dataset.name = channel.name;

            link.addEventListener('click', (e) => {
                e.preventDefault();
                // 移除所有高亮
                document.querySelectorAll('#channels li a').forEach(a => a.classList.remove('active'));
                // 添加当前高亮
                link.classList.add('active');
                
                playChannel(link.dataset.url, link.dataset.name);
            });

            listItem.appendChild(link);
            channelListUl.appendChild(listItem);
        });

        updateStatus(`成功加载 ${channels.length} 个频道。`, 'success');
    }

    /**
     * 播放指定的频道流
     * @param {string} url - 频道 M3U8/MP4 等流地址
     * @param {string} name - 频道名称
     */
    function playChannel(url, name) {
        updateStatus(`正在尝试播放: ${name}`, 'info');

        // 停止并清理旧的 HLS 实例
        if (player.hls) {
            player.hls.destroy();
            player.hls = null;
        }
        
        // ⭐ 使用 Worker 代理封装流地址
        // 这对于 HLS 片段的 CORS 和相对路径解析至关重要
        const proxiedUrl = WORKER_PROXY_BASE_URL + encodeURIComponent(url);
        
        // 尝试使用 hls.js (推荐用于 M3U8)
        if (Hls.isSupported()) {
            player.pause(); // 暂停 Video.js
            
            player.hls = new Hls({
                // 启用调试日志
                debug: false, 
                xhrSetup: function (xhr, url) {
                    // Worker 代理会处理 CORS，这里可以添加额外的请求头部
                    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); 
                }
            });
            
            player.hls.loadSource(proxiedUrl); // 使用代理后的 URL 加载流
            player.hls.attachMedia(videoElement);

            player.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                player.play().catch(e => {
                    // 改进播放错误提示：如果自动播放失败，提示用户手动点击
                    console.log("Player autoplay blocked:", e);
                    updateStatus(`频道 ${name} 已加载。请点击播放按钮开始播放 (浏览器限制)。`, 'info');
                });
                updateStatus(`频道播放中: ${name}`, 'success');
            });

            player.hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            // Worker 代理可以解决大部分网络错误，这里错误可能意味着 Worker 本身失败或源站拒绝。
                            updateStatus(`HLS 网络错误: 无法加载流片段。请检查 Worker 代理是否正常运行或流源是否有效。`, 'error');
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            updateStatus(`HLS 媒体错误: 视频播放失败。`, 'error');
                            break;
                        default:
                            player.hls.destroy();
                            updateStatus(`HLS 致命错误: ${data.details}`, 'error');
                            break;
                    }
                }
            });

        } 
        // 尝试 Video.js 原生播放 (用于 MP4 或浏览器原生支持的 HLS)
        else if (videoElement.canPlayType('application/vnd.apple.mpegurl') || videoElement.canPlayType('application/x-mpegURL')) {
            videoElement.src = proxiedUrl;
            player.load();
            player.play().catch(e => {
                 // 改进播放错误提示
                console.log("Player autoplay blocked:", e);
                updateStatus(`频道 ${name} 已加载。请点击播放按钮开始播放 (浏览器限制)。`, 'info');
            });
            updateStatus(`频道播放中: ${name}`, 'success');
        } 
        // 都不支持
        else {
            updateStatus('错误: 您的浏览器不支持 HLS/M3U8 流播放。', 'error');
        }
    }

    // ==========================================================
    // 事件监听器
    // ==========================================================
    loadButton.addEventListener('click', async () => {
        const m3uUrl = iptvUrlInput.value.trim();
        if (!m3uUrl) {
            updateStatus('请输入 M3U 订阅链接！', 'error');
            return;
        }
        
        localStorage.setItem('iptvUrl', m3uUrl);

        const m3uContent = await fetchM3UContent(m3uUrl);
        
        if (m3uContent) {
            const channels = parseM3U(m3uContent);
            renderChannels(channels);
            
            if (channels.length > 0) {
                // 默认播放第一个频道
                // 使用 setTimeout 确保 DOM 渲染完成
                setTimeout(() => {
                    document.querySelector('#channels li a')?.click();
                }, 50); 
            } else {
                 updateStatus('M3U 文件已加载，但未找到任何频道。', 'error');
            }
        }
    });

    // 从本地存储加载 URL (可选优化)
    const storedUrl = localStorage.getItem('iptvUrl');
    if (storedUrl) {
        iptvUrlInput.value = storedUrl;
        // 自动触发加载
        loadButton.click(); 
    }
});
